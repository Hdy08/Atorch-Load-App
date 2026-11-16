//! Exclusive, explicitly started vendor USB update/recovery. No polling runs
//! alongside the bootloader, and no implicit write retry or load restart occurs.
use crate::{DeviceInfo, DeviceManager};
use atorch_protocol::firmware::Image;
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{atomic::Ordering, Arc},
};

/// Platform USB lifecycle around the shared vendor transfer engine.
/// Android holds its optional Host role across APP/IAP re-enumeration.
pub trait FirmwareHost: Send + Sync + 'static {
    fn check_available(&self) -> Result<(), String>;
    fn discover(&self) -> Result<Vec<DeviceInfo>, String>;
    fn profile(&self, info: &DeviceInfo) -> Result<bool, String>;
    fn open(&self, info: &DeviceInfo) -> Result<Box<dyn crate::Transport>, String>;
    fn begin(&self) -> Result<(), String> {
        Ok(())
    }
    fn finish(&self, _success: bool) -> Result<(), String> {
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirmwareStatus {
    pub active: bool,
    pub cancellable: bool,
    pub phase: String,
    pub acknowledged_blocks: u16,
    pub blocks: u16,
    pub bytes: usize,
    pub sha256: String,
    pub message: String,
    pub started_at: u64,
    pub finished_at: Option<u64>,
    pub log_path: String,
    pub flash_confirmed: bool,
    pub restored_device: Option<DeviceInfo>,
}

impl DeviceManager {
    pub fn start_firmware(
        self: &Arc<Self>,
        path: String,
        image: Image,
        directory: PathBuf,
    ) -> Result<(), String> {
        #[cfg(target_os = "windows")]
        {
            engine::start(self, path, image, directory, Arc::new(engine::WindowsHost))
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (path, image, directory);
            Err("实机升级目前仅在 Windows 开放；此平台可使用离线预演".into())
        }
    }
    #[cfg(any(target_os = "windows", target_os = "android"))]
    pub fn start_firmware_with_host(
        self: &Arc<Self>,
        path: String,
        image: Image,
        directory: PathBuf,
        host: Arc<dyn FirmwareHost>,
    ) -> Result<(), String> {
        engine::start(self, path, image, directory, host)
    }
    pub fn cancel_firmware(&self) -> Result<(), String> {
        let state = self.state.lock().unwrap();
        let status = state.firmware.as_ref().ok_or("当前没有升级任务")?;
        if !status.active || !status.cancellable {
            return Err("当前阶段不能中止；烧写完成前请保持供电".into());
        }
        self.firmware_cancel.store(true, Ordering::Release);
        Ok(())
    }
}

#[cfg(any(target_os = "windows", target_os = "android"))]
mod engine {
    use super::*;
    #[cfg(target_os = "windows")]
    use crate::{discover, open_hid};
    use crate::{now_ms, Transport};
    use atorch_protocol::{
        firmware::{enter_bootloader, hex, legacy, Phase, Session},
        Report,
    };
    use std::{
        fs::{File, OpenOptions},
        io::{BufWriter, Write},
        thread,
        time::{Duration, Instant},
    };

    #[cfg(target_os = "windows")]
    pub fn official_app_running() -> Result<bool, String> {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
            System::Diagnostics::ToolHelp::*,
        };
        // Read-only process enumeration. Do not stop, inject into, or alter apps.
        unsafe {
            let handle = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if handle == INVALID_HANDLE_VALUE {
                return Err("无法检查官方程序是否仍在占用设备".into());
            }
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            let mut present = false;
            let mut valid = Process32FirstW(handle, &mut entry);
            while valid != 0 {
                let n = entry.szExeFile.iter().position(|v| *v == 0).unwrap_or(260);
                if String::from_utf16_lossy(&entry.szExeFile[..n])
                    .eq_ignore_ascii_case("Load_Application.exe")
                {
                    present = true;
                    break;
                }
                valid = Process32NextW(handle, &mut entry);
            }
            CloseHandle(handle);
            Ok(present)
        }
    }
    #[cfg(target_os = "windows")]
    fn profile(info: &DeviceInfo) -> Result<bool, String> {
        let api = hidapi::HidApi::new().map_err(|e| e.to_string())?;
        let device = api
            .device_list()
            .find(|v| v.path().to_string_lossy() == info.path)
            .ok_or("设备已移除，请重新扫描")?;
        match (
            device.manufacturer_string(),
            device.usage_page(),
            device.usage(),
        ) {
            (Some("IAP"), 0xff00, 1) => Ok(true),
            (Some("APP"), 0xff02, 2) => Ok(false),
            _ => Err("无法识别设备的 APP / IAP USB 接口".into()),
        }
    }
    #[cfg(target_os = "windows")]
    pub struct WindowsHost;
    #[cfg(target_os = "windows")]
    impl FirmwareHost for WindowsHost {
        fn check_available(&self) -> Result<(), String> {
            if official_app_running()? {
                Err("请先退出官方 Load_Application.exe，避免普通轮询和多个升级句柄干扰传输".into())
            } else {
                Ok(())
            }
        }
        fn discover(&self) -> Result<Vec<DeviceInfo>, String> {
            discover()
        }
        fn profile(&self, info: &DeviceInfo) -> Result<bool, String> {
            profile(info)
        }
        fn open(&self, info: &DeviceInfo) -> Result<Box<dyn Transport>, String> {
            open_hid(info)
        }
    }
    fn status(manager: &DeviceManager, phase: &str, message: &str, cancellable: bool) {
        if let Some(s) = manager.state.lock().unwrap().firmware.as_mut() {
            s.phase = phase.into();
            s.message = message.into();
            s.cancellable = cancellable;
        }
    }
    pub fn start(
        manager: &Arc<DeviceManager>,
        path: String,
        image: Image,
        directory: PathBuf,
        host: Arc<dyn FirmwareHost>,
    ) -> Result<(), String> {
        host.check_available()?;
        let mut worker = manager.firmware_worker.lock().unwrap();
        if worker.as_ref().is_some_and(|w| !w.is_finished()) {
            return Err("已有固件升级任务正在执行".into());
        }
        if let Some(w) = worker.take() {
            let _ = w.join();
        }
        let info = host
            .discover()?
            .into_iter()
            .find(|v| v.path == path)
            .ok_or("未找到所选 USB 设备，请重新扫描")?;
        host.profile(&info)?;
        let before = manager.snapshot();
        if before.connected && before.device.as_ref().is_none_or(|d| d.path != path) {
            return Err("所选升级设备与当前连接不同，请先手动断开".into());
        }
        if before.recording.is_some() {
            // The explicit upgrade confirmation closes the current CSV before
            // disconnecting monitoring and taking exclusive ownership of USB.
            manager.record(None)?;
        }
        if manager.maintenance.swap(true, Ordering::AcqRel) {
            return Err("已有维护任务".into());
        }
        if let Err(error) = host.begin() {
            manager.maintenance.store(false, Ordering::Release);
            return Err(error);
        }
        manager.disconnect();
        manager.firmware_cancel.store(false, Ordering::Release);
        let log_path = directory.join(format!("Atorch_firmware_{}.jsonl", now_ms()));
        manager.state.lock().unwrap().firmware = Some(FirmwareStatus {
            active: true,
            cancellable: true,
            phase: "preparing".into(),
            acknowledged_blocks: 0,
            blocks: image.info.blocks,
            bytes: image.info.bytes,
            sha256: image.info.sha256.clone(),
            message: "正在检查设备与 USB 状态".into(),
            started_at: now_ms(),
            finished_at: None,
            log_path: log_path.to_string_lossy().into(),
            flash_confirmed: false,
            restored_device: None,
        });
        let manager = Arc::clone(manager);
        *worker = Some(thread::spawn(move || {
            let result = (|| {
                std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
                let file = OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&log_path)
                    .map_err(|e| e.to_string())?;
                let mut log = BufWriter::new(file);
                let restored = execute(&manager, info, image, host.as_ref(), &mut log);
                log.flush().map_err(|e| e.to_string())?;
                let restored = restored?;
                // Restore read-only monitoring only after FF and fresh normal
                // reports. No target, running, calibration or counters are set.
                manager.connect_internal(
                    restored.clone(),
                    host.open(&restored)?,
                    directory.parent().unwrap_or(&directory).join("recordings"),
                )?;
                if let Some(s) = manager.state.lock().unwrap().firmware.as_mut() {
                    s.restored_device = Some(restored);
                }
                Ok::<_, String>(())
            })();
            // Platform ownership follows restored monitoring, independently
            // of FF completion. Android must release its USB role when no
            // monitoring connection was established after the flash.
            let result = match host.finish(result.is_ok()) {
                Ok(()) => result,
                Err(error) => Err(format!("{error}；平台 USB 维护会话未正常结束")),
            };
            let mut state = manager.state.lock().unwrap();
            if let Some(s) = state.firmware.as_mut() {
                s.active = false;
                s.cancellable = false;
                s.finished_at = Some(now_ms());
                match result {
                    Ok(()) => {
                        s.phase = "complete".into();
                        s.message = "设备确认烧写完成，正常应用回读通过，已恢复只读监测".into();
                    }
                    Err(error) if s.flash_confirmed => {
                        // Like the vendor, FF determines transfer completion.
                        // Failure to reopen the new application is reported
                        // separately and does not reject a different firmware.
                        s.phase = "complete".into();
                        s.message = format!("设备已确认烧写完成；{error}");
                    }
                    Err(error) => {
                        s.phase = if manager.firmware_cancel.load(Ordering::Acquire) {
                            "cancelled"
                        } else {
                            "failed"
                        }
                        .into();
                        s.message = error;
                    }
                }
            }
            manager.maintenance.store(false, Ordering::Release);
        }));
        Ok(())
    }
    fn audit(log: &mut BufWriter<File>, kind: &str, bytes: &[u8]) -> Result<(), String> {
        writeln!(
            log,
            "{}",
            serde_json::json!({"timestamp":now_ms(),"kind":kind,"hex":hex(bytes)})
        )
        .map_err(|e| e.to_string())
    }
    fn normal_readback(
        transport: &mut dyn Transport,
        log: &mut BufWriter<File>,
    ) -> Result<(), String> {
        let mut bytes = [0; 256];
        for _ in 0..8 {
            if transport.read(&mut bytes, 1)? == 0 {
                break;
            }
        }
        let end = Instant::now() + Duration::from_secs(3);
        let mut next_query = Instant::now();
        let mut kind = 3;
        let (mut settings, mut telemetry) = (false, false);
        while Instant::now() < end {
            if Instant::now() >= next_query {
                let query = atorch_protocol::query(1, kind);
                audit(log, "tx_readback", &query)?;
                transport.write(&query)?;
                kind = if kind == 3 { 5 } else { 3 };
                next_query = Instant::now() + Duration::from_millis(200);
            }
            let n = transport.read(&mut bytes, 100)?;
            if n > 0 {
                audit(log, "rx_readback", &bytes[..n])?;
            }
            match atorch_protocol::parse(&bytes[..n], 1, now_ms()) {
                Ok(Report::Settings(_)) => settings = true,
                Ok(Report::Telemetry(_)) => telemetry = true,
                _ => {}
            }
            if settings && telemetry {
                return Ok(());
            }
        }
        Err("未得到新的参数和遥测回读".into())
    }
    fn wait_profile(host: &dyn FirmwareHost, iap: bool) -> Result<DeviceInfo, String> {
        let end = Instant::now() + Duration::from_secs(15);
        while Instant::now() < end {
            let candidates: Vec<_> = host
                .discover()?
                .into_iter()
                .filter(|d| host.profile(d) == Ok(iap))
                .collect();
            if candidates.len() == 1 {
                return Ok(candidates[0].clone());
            }
            if candidates.len() > 1 {
                return Err("检测到多个候选 USB 设备，无法确认重新枚举的设备".into());
            }
            thread::sleep(Duration::from_millis(150));
        }
        Err(if iap {
            "未检测到 IAP 接口，请重新扫描后使用升级模式恢复"
        } else {
            "已经收到 FF，但正常应用尚未重新出现；请保持供电并检查设备"
        }
        .into())
    }
    fn execute(
        manager: &DeviceManager,
        initial: DeviceInfo,
        image: Image,
        host: &dyn FirmwareHost,
        log: &mut BufWriter<File>,
    ) -> Result<DeviceInfo, String> {
        let is_iap = host.profile(&initial)?;
        let mut transport = host.open(&initial)?;
        if !is_iap {
            {
                // Close the cancellation window atomically with the status
                // change, before issuing the application-to-IAP command.
                let mut state = manager.state.lock().unwrap();
                if manager.firmware_cancel.load(Ordering::Acquire) {
                    return Err("升级已取消；尚未进入 IAP".into());
                }
                if let Some(s) = state.firmware.as_mut() {
                    s.phase = "bootloader".into();
                    s.message = "已停止普通轮询，正在进入 IAP".into();
                    s.cancellable = false;
                }
            }
            let entry = enter_bootloader();
            audit(log, "tx_boot_entry", &entry)?;
            transport.write(&entry)?;
            drop(transport);
            let iap = wait_profile(host, true)?;
            transport = host.open(&iap)?;
        }
        // Descriptor bytes are diagnostic data. The platform has already
        // selected the USB interface; no captured-byte allowlist is applied.
        match transport.report_descriptor() {
            Ok(Some(descriptor)) => audit(log, "iap_descriptor", &descriptor)?,
            Ok(None) => {}
            Err(error) => writeln!(
                log,
                "{}",
                serde_json::json!({"timestamp":now_ms(),"kind":"iap_descriptor_unavailable","message":error})
            )
            .map_err(|e| e.to_string())?,
        }
        transfer(manager, image, transport.as_mut(), log)?;
        drop(transport);
        status(
            manager,
            "reconnecting",
            "已收到 FF，正在核对正常应用与遥测",
            false,
        );
        let restored = wait_profile(host, false)?;
        let mut check = host.open(&restored)?;
        normal_readback(check.as_mut(), log)?;
        // Refresh Android identity after opening grants USB permission. New
        // firmware may expose a different product name, version or serial.
        let verified = host
            .discover()?
            .into_iter()
            .find(|d| d.path == restored.path)
            .ok_or("设备在回读后移除")?;
        Ok(verified)
    }
    fn transfer(
        manager: &DeviceManager,
        image: Image,
        transport: &mut dyn Transport,
        log: &mut BufWriter<File>,
    ) -> Result<(), String> {
        transfer_with_clock(manager, image, transport, log, &mut now_ms)
    }
    fn transfer_with_clock(
        manager: &DeviceManager,
        image: Image,
        transport: &mut dyn Transport,
        log: &mut BufWriter<File>,
        clock: &mut dyn FnMut() -> u64,
    ) -> Result<(), String> {
        let bytes = image.info.bytes;
        let mut session = Session::new(image, 0);
        status(manager, "handshake", "等待 IAP 就绪应答", true);
        if manager.firmware_cancel.load(Ordering::Acquire) {
            return Err("升级已取消；未发送 IAP 握手".into());
        }
        let logical = session.start(clock()).map_err(|e| e.to_string())?;
        let wire = legacy::encode(&logical).map_err(|e| e.to_string())?;
        audit(log, "tx", &wire)?;
        transport.write(&wire)?;
        let mut buffer = [0; 256];
        loop {
            session.tick(clock()).map_err(|e| {
                format!(
                    "升级在第 {} 块停止：{e}；未自动重发，可在 IAP 重新开始",
                    session.acknowledged_blocks
                )
            })?;
            if manager.firmware_cancel.load(Ordering::Acquire) && session.phase != Phase::Writing {
                session.cancel();
                return Err("已停止发送后续分块；设备可能保留在 IAP，可重新选择固件恢复".into());
            }
            let n = transport.read(&mut buffer, 100)?;
            if n > 0 {
                audit(log, "rx", &buffer[..n])?;
                if n != 64
                    || buffer[0] != 0xaa
                    || !matches!(buffer[1], 0xbb | 0xdd | 0xee | 0xff | 0x11)
                {
                    continue;
                }
                let next = match session.receive_usb(&buffer[..n], clock()) {
                    Ok(next) => next,
                    Err(
                        atorch_protocol::firmware::FirmwareError::Crc
                        | atorch_protocol::firmware::FirmwareError::Frame,
                    ) => {
                        continue;
                    }
                    Err(e) => {
                        return Err(format!(
                            "升级在第 {} 块停止：{e}",
                            session.acknowledged_blocks
                        ))
                    }
                };
                if let Some(s) = manager.state.lock().unwrap().firmware.as_mut() {
                    s.acknowledged_blocks = session.acknowledged_blocks;
                    s.phase = match session.phase {
                        Phase::Writing => "writing",
                        Phase::Complete => "reconnecting",
                        _ => "transferring",
                    }
                    .into();
                    s.cancellable = session.phase != Phase::Writing
                        && session.phase != Phase::Complete
                        && session.acknowledged_blocks.saturating_add(1) < s.blocks;
                    s.flash_confirmed = session.phase == Phase::Complete;
                    s.message = if session.phase == Phase::Writing {
                        "数据已传完，等待设备确认烧写完成".into()
                    } else {
                        format!(
                            "已确认 {} / {} 块，共 {} 字节",
                            session.acknowledged_blocks, s.blocks, bytes
                        )
                    };
                }
                if let Some(logical) = next {
                    if manager.firmware_cancel.load(Ordering::Acquire) {
                        session.cancel();
                        return Err(
                            "已停止发送后续分块；设备可能保留在 IAP，可重新选择固件恢复".into()
                        );
                    }
                    let wire = legacy::encode(&logical).map_err(|e| e.to_string())?;
                    audit(log, "tx", &wire)?;
                    transport.write(&wire)?;
                }
                if session.phase == Phase::Complete {
                    log.flush().map_err(|e| e.to_string())?;
                    return Ok(());
                }
            }
        }
    }

    #[cfg(all(test, target_os = "windows"))]
    mod tests {
        use super::*;
        use atorch_protocol::firmware::crc16;
        use std::{
            collections::VecDeque,
            sync::atomic::{AtomicU64, AtomicU8},
        };

        fn image() -> Image {
            Image::inspect("experiment.bin", vec![0x5a; 117]).unwrap()
        }
        fn wire_reply(mut packet: Vec<u8>, kind: u8) -> Vec<u8> {
            packet[0] = kind;
            let length = packet[1] as usize;
            let crc = crc16(&packet[..length - 2]);
            packet[length - 2..length].copy_from_slice(&crc.to_le_bytes());
            let mut wire = vec![0xaa; 1];
            wire.extend_from_slice(&packet[..63]);
            wire
        }
        #[derive(Clone, Copy, PartialEq)]
        enum Behavior {
            Success,
            BadDataThenValid,
            WrongIndex,
            PrematureFf,
            NoFf,
            BadFfStatus,
            Cancel,
            CancelAtLast,
        }
        struct Bootloader<'a> {
            manager: &'a DeviceManager,
            behavior: Behavior,
            replies: VecDeque<Vec<u8>>,
            writes: Vec<Vec<u8>>,
        }
        impl Transport for Bootloader<'_> {
            fn write(&mut self, data: &[u8]) -> Result<(), String> {
                assert_eq!(data.len(), 64);
                assert_eq!(data[0], 0x55);
                self.writes.push(data.to_vec());
                match data[1] {
                    0xaa => {
                        assert_eq!(data, legacy::encode(&image().handshake()).unwrap());
                        let bb = wire_reply(image().handshake(), 0xbb);
                        // Real official capture includes duplicated BB on a second
                        // handle. A duplicate reaching this handle is also harmless.
                        self.replies.extend([bb.clone(), bb]);
                    }
                    0xcc => {
                        let index = u16::from_le_bytes([data[3], data[4]]);
                        assert_eq!(
                            data,
                            legacy::encode(&image().block(index).unwrap()).unwrap()
                        );
                        if index == 2 {
                            assert!(!self.manager.snapshot().firmware.unwrap().cancellable);
                            if self.behavior == Behavior::CancelAtLast {
                                assert!(self.manager.cancel_firmware().is_err());
                            }
                        }
                        let reply = if self.behavior == Behavior::WrongIndex {
                            wire_reply(image().block(1).unwrap(), 0xdd)
                        } else if self.behavior == Behavior::PrematureFf {
                            ff(false)
                        } else {
                            wire_reply(
                                image().block(index).unwrap(),
                                if index == 2 { 0xee } else { 0xdd },
                            )
                        };
                        if self.behavior == Behavior::BadDataThenValid {
                            let mut bad = reply.clone();
                            bad[6] ^= 1;
                            self.replies.push_back(bad);
                        }
                        self.replies.push_back(reply);
                        if index == 2 && self.behavior != Behavior::NoFf {
                            self.replies
                                .push_back(ff(self.behavior == Behavior::BadFfStatus));
                        }
                    }
                    _ => panic!("ordinary query or unrecognized firmware packet"),
                }
                Ok(())
            }
            fn read(&mut self, buffer: &mut [u8], _: i32) -> Result<usize, String> {
                if self.behavior == Behavior::Cancel {
                    self.manager.cancel_firmware().unwrap();
                }
                if let Some(reply) = self.replies.pop_front() {
                    buffer[..reply.len()].copy_from_slice(&reply);
                    Ok(reply.len())
                } else {
                    Ok(0)
                }
            }
        }
        fn ff(bad_status: bool) -> Vec<u8> {
            let mut packet = vec![0; 64];
            packet[..4].copy_from_slice(&[0xff, 6, u8::from(bad_status), 0]);
            wire_reply(packet, 0xff)
        }
        fn run(behavior: Behavior) -> (Result<(), String>, usize, FirmwareStatus) {
            let manager = DeviceManager::default();
            manager.state.lock().unwrap().firmware = Some(FirmwareStatus {
                active: true,
                cancellable: true,
                phase: "preparing".into(),
                acknowledged_blocks: 0,
                blocks: 3,
                bytes: 117,
                sha256: image().info.sha256,
                message: String::new(),
                started_at: 0,
                finished_at: None,
                log_path: String::new(),
                flash_confirmed: false,
                restored_device: None,
            });
            let mut transport = Bootloader {
                manager: &manager,
                behavior,
                replies: VecDeque::new(),
                writes: vec![],
            };
            static ID: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "atorch-fw-test-{}-{}.jsonl",
                std::process::id(),
                ID.fetch_add(1, Ordering::Relaxed)
            ));
            let result = {
                let mut log = BufWriter::new(File::create(&path).unwrap());
                let mut time = 0;
                transfer_with_clock(&manager, image(), &mut transport, &mut log, &mut || {
                    time += 1000;
                    time
                })
            };
            std::fs::remove_file(path).unwrap();
            (
                result,
                transport.writes.len(),
                manager.snapshot().firmware.unwrap(),
            )
        }
        #[test]
        fn exclusive_transfer_requires_ee_ff_and_checks_echoes() {
            for behavior in [
                Behavior::Success,
                Behavior::BadDataThenValid,
                Behavior::CancelAtLast,
            ] {
                let (result, writes, status) = run(behavior);
                assert!(result.is_ok(), "{result:?}");
                assert_eq!(
                    writes, 4,
                    "AA plus exactly three CC; no ordinary queries or retries"
                );
                assert_eq!(status.acknowledged_blocks, 3);
                assert!(status.flash_confirmed);
            }
        }
        #[test]
        fn transfer_does_not_accept_wrong_index_or_early_completion() {
            for behavior in [Behavior::WrongIndex, Behavior::PrematureFf] {
                let (result, writes, status) = run(behavior);
                assert!(result.unwrap_err().contains("序号"));
                assert_eq!(writes, 2);
                assert_eq!(status.acknowledged_blocks, 0);
                assert!(!status.flash_confirmed);
            }
        }
        #[test]
        fn ee_alone_and_nonzero_ff_never_mean_success() {
            for behavior in [Behavior::NoFf, Behavior::BadFfStatus] {
                let (result, writes, status) = run(behavior);
                assert!(result.unwrap_err().contains("超时"));
                assert_eq!(writes, 4);
                assert_eq!(status.acknowledged_blocks, 3);
                assert!(!status.flash_confirmed);
                assert!(!status.cancellable);
            }
        }
        #[test]
        fn cancellation_does_not_send_first_block() {
            let (result, writes, status) = run(Behavior::Cancel);
            assert!(result.unwrap_err().contains("停止发送"));
            assert_eq!(writes, 1);
            assert!(!status.flash_confirmed);
        }
        #[test]
        fn arbitrary_firmware_runs_through_app_iap_and_changed_app_identity() {
            struct State {
                mode: AtomicU8,
                writes: std::sync::Mutex<Vec<Vec<u8>>>,
                finished: std::sync::Mutex<Option<bool>>,
                no_app_after_flash: bool,
            }
            struct Host(Arc<State>);
            struct Device {
                state: Arc<State>,
                iap: bool,
                pending: VecDeque<Vec<u8>>,
            }
            impl FirmwareHost for Host {
                fn check_available(&self) -> Result<(), String> {
                    Ok(())
                }
                fn discover(&self) -> Result<Vec<DeviceInfo>, String> {
                    let (path, name, serial) = match self.0.mode.load(Ordering::Acquire) {
                        0 => ("before", "ATORCH DL24 V1.0.9", "before-serial"),
                        1 => ("iap", "ATORCH BW600 V1.0.3", "iap-serial"),
                        _ if self.0.no_app_after_flash => return Err("模拟：正常应用未重连".into()),
                        _ => ("after", "ATORCH BW600 V9.8.7", "changed-serial"),
                    };
                    Ok(vec![DeviceInfo {
                        path: path.into(),
                        name: name.into(),
                        serial: serial.into(),
                        vendor_id: atorch_protocol::VENDOR_ID,
                        product_id: atorch_protocol::PRODUCT_ID,
                        transport: crate::TransportKind::Usb,
                        rssi: None,
                    }])
                }
                fn profile(&self, info: &DeviceInfo) -> Result<bool, String> {
                    Ok(info.path == "iap")
                }
                fn open(&self, info: &DeviceInfo) -> Result<Box<dyn Transport>, String> {
                    Ok(Box::new(Device {
                        state: Arc::clone(&self.0),
                        iap: info.path == "iap",
                        pending: VecDeque::new(),
                    }))
                }
                fn finish(&self, success: bool) -> Result<(), String> {
                    *self.0.finished.lock().unwrap() = Some(success);
                    Ok(())
                }
            }
            impl Transport for Device {
                fn report_descriptor(&self) -> Result<Option<Vec<u8>>, String> {
                    // The platform identifies the interface. Exact captured
                    // descriptor bytes must not gate a selected firmware.
                    Ok(Some(vec![1, 2, 3]))
                }
                fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
                    self.state.writes.lock().unwrap().push(bytes.to_vec());
                    if self.iap {
                        assert_eq!(bytes[0], 0x55);
                        match bytes[1] {
                            0xaa => self
                                .pending
                                .push_back(wire_reply(image().handshake(), 0xbb)),
                            0xcc => {
                                let index = u16::from_le_bytes([bytes[3], bytes[4]]);
                                assert_eq!(
                                    bytes,
                                    legacy::encode(&image().block(index).unwrap()).unwrap()
                                );
                                self.pending.push_back(wire_reply(
                                    image().block(index).unwrap(),
                                    if index == 2 { 0xee } else { 0xdd },
                                ));
                                if index == 2 {
                                    self.pending.push_back(ff(false));
                                    self.state.mode.store(2, Ordering::Release);
                                }
                            }
                            _ => panic!("unexpected IAP write"),
                        }
                    } else if bytes == enter_bootloader() {
                        self.state.mode.store(1, Ordering::Release);
                    } else {
                        assert!(matches!(bytes[3], 3 | 5));
                        let mut reply = vec![0; 64];
                        reply[..4].copy_from_slice(&[0xaa, 5, 1, bytes[3]]);
                        reply[62..].copy_from_slice(&[0xee, 0xff]);
                        if bytes[3] == 5 {
                            reply[8..12].copy_from_slice(&20_000u32.to_le_bytes());
                            reply[52] = 1;
                        }
                        self.pending.push_back(reply);
                    }
                    Ok(())
                }
                fn read(&mut self, bytes: &mut [u8], _: i32) -> Result<usize, String> {
                    if let Some(reply) = self.pending.pop_front() {
                        bytes[..reply.len()].copy_from_slice(&reply);
                        Ok(reply.len())
                    } else {
                        thread::sleep(Duration::from_millis(1));
                        Ok(0)
                    }
                }
            }
            for no_app_after_flash in [false, true] {
                let state = Arc::new(State {
                    mode: AtomicU8::new(0),
                    writes: Default::default(),
                    finished: Default::default(),
                    no_app_after_flash,
                });
                let root = std::env::temp_dir().join(format!(
                    "atorch-fw-policy-{}-{}-{no_app_after_flash}",
                    std::process::id(),
                    now_ms(),
                ));
                std::fs::create_dir(&root).unwrap();
                let manager = Arc::new(DeviceManager::default());
                start(
                    &manager,
                    "before".into(),
                    image(),
                    root.join("logs"),
                    Arc::new(Host(Arc::clone(&state))),
                )
                .unwrap();
                let deadline = Instant::now() + Duration::from_secs(4);
                while manager.firmware_active() {
                    assert!(Instant::now() < deadline, "simulated update did not finish");
                    thread::sleep(Duration::from_millis(5));
                }
                let job = manager.snapshot().firmware.unwrap();
                assert_eq!(job.phase, "complete");
                assert!(job.flash_confirmed);
                assert_eq!(job.acknowledged_blocks, 3);
                assert_eq!(*state.finished.lock().unwrap(), Some(!no_app_after_flash));
                assert_eq!(state.writes.lock().unwrap()[0], enter_bootloader());
                if no_app_after_flash {
                    assert!(job.restored_device.is_none());
                    assert!(job.message.contains("正常应用未重连"));
                } else {
                    let restored = job.restored_device.unwrap();
                    assert_eq!(restored.name, "ATORCH BW600 V9.8.7");
                    assert_eq!(restored.serial, "changed-serial");
                }
                manager.disconnect();
                if let Some(worker) = manager.firmware_worker.lock().unwrap().take() {
                    worker.join().unwrap();
                }
                let owned = root.canonicalize().unwrap();
                assert_eq!(
                    owned.parent().unwrap(),
                    std::env::temp_dir().canonicalize().unwrap()
                );
                std::fs::remove_dir_all(owned).unwrap();
            }
        }
        #[test]
        fn post_flash_readback_spaces_queries_and_accepts_nonzero_running_telemetry() {
            struct IdleDevice {
                previous: Option<Instant>,
                pending: VecDeque<Vec<u8>>,
                queries: Vec<u8>,
            }
            impl Transport for IdleDevice {
                fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
                    if let Some(previous) = self.previous {
                        assert!(previous.elapsed() >= Duration::from_millis(150));
                    }
                    self.previous = Some(Instant::now());
                    assert!(
                        matches!(bytes[3], 3 | 5),
                        "readback must never issue a control command"
                    );
                    self.queries.push(bytes[3]);
                    let mut reply = vec![0; 64];
                    reply[..4].copy_from_slice(&[0xaa, 5, 1, bytes[3]]);
                    reply[62..].copy_from_slice(&[0xee, 0xff]);
                    if bytes[3] == 5 {
                        reply[8..12].copy_from_slice(&20_000u32.to_le_bytes());
                        reply[52] = 1;
                    }
                    self.pending.push_back(reply);
                    Ok(())
                }
                fn read(&mut self, bytes: &mut [u8], _: i32) -> Result<usize, String> {
                    if let Some(reply) = self.pending.pop_front() {
                        bytes[..64].copy_from_slice(&reply);
                        Ok(64)
                    } else {
                        thread::sleep(Duration::from_millis(5));
                        Ok(0)
                    }
                }
            }
            let mut device = IdleDevice {
                previous: None,
                pending: VecDeque::new(),
                queries: vec![],
            };
            let path =
                std::env::temp_dir().join(format!("atorch-preflight-{}.jsonl", std::process::id()));
            {
                let mut log = BufWriter::new(File::create(&path).unwrap());
                normal_readback(&mut device, &mut log).unwrap();
            }
            std::fs::remove_file(path).unwrap();
            assert_eq!(device.queries, vec![3, 5]);
        }
    }
}
