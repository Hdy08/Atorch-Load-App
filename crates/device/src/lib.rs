//! Serialized device I/O and recording, independent of Tauri and the frontend.
pub mod firmware;
mod recorder;
pub mod recordings;
pub mod sampling;
pub mod special;
#[cfg(test)]
mod tests;
use atorch_protocol::{Command, DeviceSettings, Report, Telemetry};
#[cfg(not(target_os = "android"))]
use atorch_protocol::{PRODUCT_ID, VENDOR_ID};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub path: String,
    pub name: String,
    pub serial: String,
    pub vendor_id: u16,
    pub product_id: u16,
    #[serde(default)]
    pub transport: TransportKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rssi: Option<i16>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransportKind {
    #[default]
    Usb,
    Bluetooth,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub timestamp: u64,
    pub level: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    #[serde(flatten)]
    pub telemetry: Telemetry,
    pub elapsed_ms: u64,
    pub segment_id: u64,
}

impl std::ops::Deref for Sample {
    type Target = Telemetry;
    fn deref(&self) -> &Self::Target {
        &self.telemetry
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub connected: bool,
    pub device: Option<DeviceInfo>,
    pub telemetry: Option<Telemetry>,
    pub settings: Option<DeviceSettings>,
    pub sample_count: u64,
    pub sampling_paused: bool,
    pub sampling_elapsed_ms: u64,
    #[serde(skip)]
    sampling_clock: sampling::SampleClock,
    #[serde(skip)]
    recording_clock: sampling::SampleClock,
    pub usb_sample_rate_hz: u8,
    pub connected_at: u64,
    pub last_report_at: u64,
    pub recording: Option<String>,
    pub recording_paused: bool,
    pub recording_error: Option<String>,
    pub error: Option<String>,
    pub logs: VecDeque<LogEntry>,
    pub special_test: Option<special::SpecialTest>,
    pub special_results: VecDeque<special::SpecialResult>,
    pub firmware: Option<firmware::FirmwareStatus>,
}

impl Default for Snapshot {
    fn default() -> Self {
        Self {
            connected: false,
            device: None,
            telemetry: None,
            settings: None,
            sample_count: 0,
            sampling_paused: false,
            sampling_elapsed_ms: 0,
            sampling_clock: sampling::SampleClock::default(),
            recording_clock: sampling::SampleClock::default(),
            usb_sample_rate_hz: sampling::DEFAULT_USB_HZ,
            connected_at: 0,
            last_report_at: 0,
            recording: None,
            recording_paused: false,
            recording_error: None,
            error: None,
            logs: VecDeque::new(),
            special_test: None,
            special_results: VecDeque::new(),
            firmware: None,
        }
    }
}

pub trait Transport: Send {
    fn report_descriptor(&self) -> Result<Option<Vec<u8>>, String> {
        Ok(None)
    }
    fn kind(&self) -> TransportKind {
        TransportKind::Usb
    }
    fn write(&mut self, report: &[u8]) -> Result<(), String>;
    fn read(&mut self, buffer: &mut [u8], timeout_ms: i32) -> Result<usize, String>;
}

#[cfg(not(target_os = "android"))]
pub fn discover() -> Result<Vec<DeviceInfo>, String> {
    let api = hidapi::HidApi::new().map_err(|e| e.to_string())?;
    Ok(api
        .device_list()
        .filter(|d| d.vendor_id() == VENDOR_ID && d.product_id() == PRODUCT_ID)
        .map(|d| DeviceInfo {
            path: d.path().to_string_lossy().to_string(),
            name: d.product_string().unwrap_or("ATORCH Load").into(),
            serial: d.serial_number().unwrap_or("").into(),
            vendor_id: d.vendor_id(),
            product_id: d.product_id(),
            transport: TransportKind::Usb,
            rssi: None,
        })
        .collect())
}

#[cfg(not(target_os = "android"))]
pub fn open_hid(info: &DeviceInfo) -> Result<Box<dyn Transport>, String> {
    struct Hid(hidapi::HidDevice);
    impl Transport for Hid {
        fn report_descriptor(&self) -> Result<Option<Vec<u8>>, String> {
            let mut bytes = [0; 512];
            let n = self
                .0
                .get_report_descriptor(&mut bytes)
                .map_err(|e| e.to_string())?;
            Ok(Some(bytes[..n].to_vec()))
        }
        fn write(&mut self, data: &[u8]) -> Result<(), String> {
            // BW150 descriptor has unnumbered 64-byte reports. HIDAPI needs a
            // leading zero report ID; 0x55 is the protocol header, not a report ID.
            let mut report = Vec::with_capacity(data.len() + 1);
            report.push(0);
            report.extend_from_slice(data);
            let n = self.0.write(&report).map_err(|e| e.to_string())?;
            if n < report.len() {
                return Err(format!("Short USB write: {n}/{}", report.len()));
            }
            Ok(())
        }
        fn read(&mut self, b: &mut [u8], timeout: i32) -> Result<usize, String> {
            self.0.read_timeout(b, timeout).map_err(|e| e.to_string())
        }
    }
    let api = hidapi::HidApi::new().map_err(|e| e.to_string())?;
    let path = std::ffi::CString::new(info.path.clone()).map_err(|e| e.to_string())?;
    Ok(Box::new(Hid(api
        .open_path(&path)
        .map_err(|e| e.to_string())?)))
}

enum Request {
    Stop,
    Command(Command, mpsc::Sender<Result<(), String>>),
    BleCommand(
        atorch_protocol::ble::Command,
        mpsc::Sender<Result<BleCommandResult, String>>,
    ),
    Record(Option<PathBuf>, mpsc::Sender<Result<(), String>>),
    ClearSamples(mpsc::Sender<Result<(), String>>),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BleCommandResult {
    pub action: atorch_protocol::ble::Command,
    pub sent_at: u64,
    /// GATT completion is NOT an execution ACK. The legacy protocol has none.
    pub device_confirmed: bool,
    pub message: String,
}

struct Worker {
    tx: mpsc::Sender<Request>,
    handle: thread::JoinHandle<()>,
}
#[derive(Default)]
pub struct DeviceManager {
    state: Arc<Mutex<Snapshot>>,
    worker: Mutex<Option<Worker>>,
    samples: Arc<Mutex<VecDeque<Sample>>>,
    sampling_preferences: Option<PathBuf>,
    maintenance: AtomicBool,
    firmware_cancel: AtomicBool,
    #[cfg(any(target_os = "windows", target_os = "android"))]
    firmware_worker: Mutex<Option<thread::JoinHandle<()>>>,
}

impl DeviceManager {
    pub fn with_sampling_preferences(path: PathBuf) -> Self {
        let mut manager = Self::default();
        manager.sampling_preferences = Some(path.clone());
        manager.state.lock().unwrap().usb_sample_rate_hz = sampling::read_usb_rate(&path);
        manager
    }
    pub fn firmware_active(&self) -> bool {
        self.maintenance.load(Ordering::Acquire)
    }
    pub fn snapshot(&self) -> Snapshot {
        let mut snapshot = self.state.lock().unwrap().clone();
        snapshot.sampling_elapsed_ms = snapshot.sampling_clock.elapsed_ms(Instant::now());
        snapshot
    }
    pub fn samples(&self) -> Vec<Sample> {
        self.samples.lock().unwrap().iter().cloned().collect()
    }
    pub fn set_usb_sample_rate(&self, hz: u8) -> Result<(), String> {
        if !sampling::valid_usb_rate(hz) {
            return Err("USB 采样率仅支持 1、2、5 或 10 Hz".into());
        }
        if self.firmware_active() {
            return Err("固件升级期间不能更改采样率".into());
        }
        let mut state = self.state.lock().unwrap();
        if state.connected
            && state
                .device
                .as_ref()
                .is_some_and(|d| d.transport == TransportKind::Bluetooth)
        {
            return Err("BLE 由设备主动上报，不能设置 USB 采样率".into());
        }
        if let Some(path) = &self.sampling_preferences {
            sampling::save_usb_rate(path, hz)?;
        }
        state.usb_sample_rate_hz = hz;
        Ok(())
    }
    pub fn set_sampling(&self, enabled: bool) -> Result<(), String> {
        if self.firmware_active() {
            return Err("固件升级期间不能更改采样状态".into());
        }
        let mut state = self.state.lock().unwrap();
        if !state.connected {
            return Err("请先连接设备".into());
        }
        state.sampling_paused = !enabled;
        state.recording_paused = state.recording.is_some() && !enabled;
        if enabled {
            state.sampling_clock.resume(Instant::now());
            state.recording_clock.resume(Instant::now());
        } else {
            state.sampling_clock.pause(Instant::now());
            state.recording_clock.pause(Instant::now());
        }
        Ok(())
    }
    pub fn clear_samples(&self) -> Result<(), String> {
        if self.firmware_active() {
            return Err("固件升级期间不能清空采样数据".into());
        }
        if self.snapshot().connected {
            let (tx, rx) = mpsc::channel();
            self.sender()?
                .send(Request::ClearSamples(tx))
                .map_err(|e| e.to_string())?;
            return rx
                .recv_timeout(Duration::from_secs(6))
                .map_err(|e| e.to_string())?;
        }
        clear_history(&self.state, &self.samples);
        Ok(())
    }
    pub fn disconnect(&self) {
        let worker = self.worker.lock().unwrap().take();
        if let Some(w) = worker {
            let _ = w.tx.send(Request::Stop);
            let _ = w.handle.join();
        }
        let mut s = self.state.lock().unwrap();
        s.connected = false;
        s.recording = None;
        s.recording_paused = false;
        s.sampling_clock.pause(Instant::now());
    }
    pub fn connect(
        &self,
        info: DeviceInfo,
        transport: Box<dyn Transport>,
        recording_dir: PathBuf,
    ) -> Result<(), String> {
        if self.firmware_active() {
            return Err("固件升级正在独占 USB，请等待完成".into());
        }
        self.connect_internal(info, transport, recording_dir)
    }
    fn connect_internal(
        &self,
        info: DeviceInfo,
        transport: Box<dyn Transport>,
        recording_dir: PathBuf,
    ) -> Result<(), String> {
        self.disconnect();
        let (tx, rx) = mpsc::channel();
        let firmware = self.state.lock().unwrap().firmware.clone();
        let usb_sample_rate_hz = self.state.lock().unwrap().usb_sample_rate_hz;
        *self.state.lock().unwrap() = Snapshot {
            connected: true,
            device: Some(info),
            connected_at: now_ms(),
            firmware,
            usb_sample_rate_hz,
            ..Default::default()
        };
        self.samples.lock().unwrap().clear();
        let state = Arc::clone(&self.state);
        let samples = Arc::clone(&self.samples);
        let handle = thread::spawn(move || {
            let result = run(transport, rx, &state, &samples, recording_dir);
            let mut s = state.lock().unwrap();
            s.connected = false;
            s.recording = None;
            s.recording_paused = false;
            s.sampling_clock.pause(Instant::now());
            if let Err(e) = result {
                log(&mut s, "error", &e);
                s.error = Some(e)
            }
        });
        *self.worker.lock().unwrap() = Some(Worker { tx, handle });
        Ok(())
    }
    fn sender(&self) -> Result<mpsc::Sender<Request>, String> {
        if !self.snapshot().connected {
            return Err("请先连接设备".into());
        }
        self.worker
            .lock()
            .unwrap()
            .as_ref()
            .map(|w| w.tx.clone())
            .ok_or_else(|| "设备未连接".into())
    }
    pub fn command(&self, cmd: Command) -> Result<(), String> {
        if self.firmware_active() {
            return Err("固件升级期间禁止设备控制".into());
        }
        if self
            .snapshot()
            .device
            .is_some_and(|d| d.transport == TransportKind::Bluetooth)
        {
            return Err("蓝牙不支持 USB 参数命令，请使用蓝牙面板遥控或 USB 连接".into());
        }
        cmd.encode(1).map_err(|e| e.to_string())?;
        let (tx, rx) = mpsc::channel();
        self.sender()?
            .send(Request::Command(cmd, tx))
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(6))
            .map_err(|_| "设备命令超时；请检查设备当前状态".to_string())?
    }
    pub fn ble_command(
        &self,
        action: atorch_protocol::ble::Command,
    ) -> Result<BleCommandResult, String> {
        if self.firmware_active() {
            return Err("固件升级期间禁止蓝牙控制".into());
        }
        let s = self.snapshot();
        if !s.connected
            || !s
                .device
                .is_some_and(|d| d.transport == TransportKind::Bluetooth)
        {
            return Err("请先连接 BW150 蓝牙设备".into());
        }
        let (tx, rx) = mpsc::channel();
        self.sender()?
            .send(Request::BleCommand(action, tx))
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(6))
            .map_err(|_| "蓝牙操作超时，执行状态未知，请查看设备屏幕，勿重复点击".to_string())?
    }
    pub fn record(&self, path: Option<PathBuf>) -> Result<(), String> {
        if self.firmware_active() {
            return Err("固件升级期间不能开始或更改录制".into());
        }
        let (tx, rx) = mpsc::channel();
        self.sender()?
            .send(Request::Record(path, tx))
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(3))
            .map_err(|e| e.to_string())?
    }
}
impl Drop for DeviceManager {
    fn drop(&mut self) {
        self.disconnect()
    }
}

fn log(s: &mut Snapshot, level: &str, message: &str) {
    s.logs.push_back(LogEntry {
        timestamp: now_ms(),
        level: level.into(),
        message: message.into(),
    });
    while s.logs.len() > 100 {
        s.logs.pop_front();
    }
}

fn clear_history(state: &Arc<Mutex<Snapshot>>, samples: &Arc<Mutex<VecDeque<Sample>>>) {
    let mut state = state.lock().unwrap();
    samples.lock().unwrap().clear();
    state.sample_count = 0;
    state.sampling_clock = sampling::SampleClock::default();
}

const HEADER:&str="DATE,VOLTAGE(V),CURRENT(A),POWER(W),RESISTANCE(Ω),E_QUANTITY(Wh),E_CAPACITY(mAh),NTC_TEMP(℃),CPU_TEMP(℃),MOS_TEMP(℃),FAN_SPEED(RPM)\n";
pub fn csv(samples: &[Sample]) -> String {
    let mut out = String::from("\u{feff}");
    out.push_str(HEADER);
    for t in samples {
        out.push_str(&csv_row(t));
    }
    out
}
fn csv_row(t: &Telemetry) -> String {
    let cell = |value: Option<f64>, precision: usize| {
        value
            .map(|v| format!("{v:.precision$}"))
            .unwrap_or_default()
    };
    format!(
        "{},{:.6},{:.6},{:.6},{},{},{:.3},{},{},{},{}\n",
        t.timestamp,
        t.voltage,
        t.current,
        t.power,
        cell(t.resistance, 3),
        cell(t.energy, 3),
        t.capacity,
        cell(t.ntc_temperature, 3),
        cell(t.cpu_temperature, 3),
        cell(t.mos_temperature, 3),
        cell(t.fan_speed, 0),
    )
}

fn accept(
    bytes: &[u8],
    state: &Arc<Mutex<Snapshot>>,
    samples: &Arc<Mutex<VecDeque<Sample>>>,
    recorder: &mut recorder::Recorder,
) -> Result<Option<Report>, String> {
    let Ok(report) = atorch_protocol::parse(bytes, 1, now_ms()) else {
        return Ok(None);
    };
    accept_report(report, state, samples, recorder).map(Some)
}

fn accept_report(
    report: Report,
    state: &Arc<Mutex<Snapshot>>,
    samples: &Arc<Mutex<VecDeque<Sample>>>,
    recorder: &mut recorder::Recorder,
) -> Result<Report, String> {
    let mut s = state.lock().unwrap();
    s.last_report_at = now_ms();
    match &report {
        Report::Telemetry(t) => {
            // Only first readback and real USB state edges synchronize sampling.
            // Identical reports must preserve the user's Pause / Continue choice.
            if s.device
                .as_ref()
                .is_some_and(|d| d.transport == TransportKind::Usb)
                && t.running.is_some()
                && s.telemetry.as_ref().and_then(|v| v.running) != t.running
            {
                s.sampling_paused = t.running == Some(false);
                let now = Instant::now();
                if s.sampling_paused {
                    s.sampling_clock.pause(now);
                    s.recording_clock.pause(now);
                } else {
                    s.sampling_clock.resume(now);
                    s.recording_clock.resume(now);
                }
            }
            if let Some(mode) = s.settings.as_ref().map(|v| v.mode) {
                let Snapshot {
                    special_test,
                    special_results,
                    ..
                } = &mut *s;
                special::observe(mode, t, special_test, special_results);
            }
            s.telemetry = Some(t.clone());
            recorder.sample(t, &mut s);
            if s.sampling_paused {
                return Ok(report);
            }
            s.sample_count += 1;
            let mut history = samples.lock().unwrap();
            history.push_back(Sample {
                telemetry: t.clone(),
                elapsed_ms: s.sampling_clock.sample(Instant::now()),
                segment_id: s.sampling_clock.segment_id(),
            });
            if history.len() > 7200 {
                history.pop_front();
            }
        }
        Report::Settings(settings) => {
            if s.settings
                .as_ref()
                .is_some_and(|previous| previous.mode != settings.mode)
            {
                s.special_test = None;
            }
            s.settings = Some(settings.clone());
        }
        _ => {}
    }
    Ok(report)
}

fn run(
    mut transport: Box<dyn Transport>,
    rx: mpsc::Receiver<Request>,
    state: &Arc<Mutex<Snapshot>>,
    samples: &Arc<Mutex<VecDeque<Sample>>>,
    recording_dir: PathBuf,
) -> Result<(), String> {
    let mut recorder = recorder::Recorder::new(recording_dir);
    let mut buffer = [0; 256];
    let bluetooth = transport.kind() == TransportKind::Bluetooth;
    let mut ble_decoder = atorch_protocol::ble::Decoder::default();
    let mut schedule =
        sampling::UsbSchedule::new(Instant::now(), state.lock().unwrap().usb_sample_rate_hz);
    let mut last_valid = Instant::now();
    let mut last_ble_write = None::<Instant>;
    log(
        &mut state.lock().unwrap(),
        "info",
        if bluetooth {
            "BLE 已连接，正在接收数据；支持原生面板键与独立清零操作"
        } else {
            "USB 已连接，正在读取设备参数"
        },
    );
    loop {
        match rx.try_recv() {
            Ok(Request::Stop) => break,
            Ok(Request::Record(path, reply)) => {
                let result = recorder.manual(path, &mut state.lock().unwrap());
                let _ = reply.send(result);
            }
            Ok(Request::ClearSamples(reply)) => {
                let result = recorder.finish_automatic(&mut state.lock().unwrap());
                if result.is_ok() {
                    clear_history(state, samples);
                }
                let _ = reply.send(result);
            }
            Ok(Request::Command(command, reply)) => {
                if bluetooth {
                    let _ = reply.send(Err("蓝牙不支持 USB 参数命令，请使用蓝牙面板遥控".into()));
                    continue;
                }
                let result = (|| {
                    // Drain earlier telemetry/ACKs before issuing a command. Never retry writes implicitly.
                    for _ in 0..8 {
                        let n = transport.read(&mut buffer, 1)?;
                        if n == 0 {
                            break;
                        }
                        accept(&buffer[..n], state, samples, &mut recorder)?;
                    }
                    if command.kind == "mode"
                        || command.kind == "stage"
                        || command.expected_mode.is_some()
                        || (command.kind == "running" && command.value == 1.0)
                    {
                        // Recheck the physical panel before a change whose meaning depends
                        // on mode/state; a cached UI snapshot may predate a panel action.
                        let deadline = Instant::now() + Duration::from_secs(1);
                        let mut next_query = Instant::now();
                        let (mut settings_seen, mut telemetry_seen) = (false, false);
                        while Instant::now() < deadline && !(settings_seen && telemetry_seen) {
                            if Instant::now() >= next_query {
                                transport.write(&atorch_protocol::query(1, 3))?;
                                transport.write(&atorch_protocol::query(1, 5))?;
                                next_query = Instant::now() + Duration::from_millis(250);
                            }
                            let n = transport.read(&mut buffer, 80)?;
                            if n == 0 {
                                continue;
                            }
                            if let Some(report) =
                                accept(&buffer[..n], state, samples, &mut recorder)?
                            {
                                settings_seen |= matches!(report, Report::Settings(_));
                                telemetry_seen |= matches!(report, Report::Telemetry(_));
                                last_valid = Instant::now();
                            }
                        }
                        if !(settings_seen && telemetry_seen) {
                            return Err(
                                "未读到最新模式与运行状态，未发送控制命令，请稍后重试".into()
                            );
                        }
                    }
                    {
                        let s = state.lock().unwrap();
                        if let Some(expected) = command.expected_mode {
                            if s.settings.as_ref().map(|v| v.mode) != Some(expected) {
                                return Err("设备模式已变化，请核对新模式及目标值后再操作".into());
                            }
                        }
                        if command.kind == "mode" {
                            let idle = s.telemetry.as_ref().is_some_and(|t| {
                                t.running == Some(false)
                                    && now_ms().saturating_sub(t.timestamp) < 2500
                            });
                            if !idle {
                                return Err("请先停止负载并等待最新运行状态，再切换模式".into());
                            }
                        }
                        if command.kind == "stage" {
                            let settings = s.settings.as_ref().ok_or("请先读取设备模式")?;
                            let telemetry = s.telemetry.as_ref().ok_or("请先读取设备阶段")?;
                            atorch_protocol::special::validate_stage(
                                &command, settings, telemetry,
                            )?;
                        }
                        if command.kind == "running" && command.value == 1.0 {
                            let settings = s.settings.as_ref().ok_or("请先读取设备模式")?;
                            if settings.mode > 8 {
                                return Err(
                                    "此模式的专用测试启动参数尚未核准，请在设备面板启动".into()
                                );
                            }
                            if matches!(settings.mode, 7 | 8) {
                                atorch_protocol::special::validate_cycle_settings(settings)?;
                                if s.telemetry.as_ref().is_some_and(|t| {
                                    atorch_protocol::special::prompt(settings.mode, t).is_some()
                                }) {
                                    return Err("设备正在等待阶段选择，请使用阶段控制操作".into());
                                }
                            }
                        }
                        if command.kind == "target"
                            && !s
                                .settings
                                .as_ref()
                                .is_some_and(|v| matches!(v.mode, 0..=3 | 7 | 8))
                        {
                            return Err(
                                "此模式不使用普通目标值，请在设备面板设置专用测试参数".into()
                            );
                        }
                    }
                    transport.write(&command.encode(1).map_err(|e| e.to_string())?)?;
                    transport.write(&atorch_protocol::query(1, 3))?;
                    transport.write(&atorch_protocol::query(1, 5))?;
                    let deadline = Instant::now() + Duration::from_secs(2);
                    let mut next_query = Instant::now() + Duration::from_millis(250);
                    while Instant::now() < deadline {
                        if Instant::now() >= next_query {
                            transport.write(&atorch_protocol::query(1, 3))?;
                            transport.write(&atorch_protocol::query(1, 5))?;
                            next_query = Instant::now() + Duration::from_millis(250);
                        }
                        let n = transport.read(&mut buffer, 100)?;
                        if n == 0 {
                            continue;
                        }
                        if let Some(report) = accept(&buffer[..n], state, samples, &mut recorder)? {
                            last_valid = Instant::now();
                            if command.matches(&report) {
                                return Ok(());
                            }
                            if let Report::Ack { status, .. } = report {
                                if status != 1 {
                                    return Err(format!("设备拒绝命令，状态码 {status}"));
                                }
                            }
                        }
                    }
                    Err("未收到设备确认，请读取设备状态后再操作".into())
                })();
                let mut s = state.lock().unwrap();
                log(
                    &mut s,
                    if result.is_ok() { "info" } else { "error" },
                    &format!(
                        "{} = {}：{}",
                        command.kind,
                        command.value,
                        result
                            .as_ref()
                            .map(|_| "设备已确认".to_string())
                            .unwrap_or_else(|e: &String| e.clone())
                    ),
                );
                drop(s);
                let _ = reply.send(result);
                schedule.refresh(Instant::now());
            }
            Ok(Request::BleCommand(action, reply)) => {
                let result = (|| {
                    if !bluetooth {
                        return Err("蓝牙面板操作不能通过 USB 发送".into());
                    }
                    if last_valid.elapsed() > Duration::from_millis(2500)
                        || state.lock().unwrap().telemetry.is_none()
                    {
                        return Err("未收到最新蓝牙数据，未发送面板操作，请重新连接".into());
                    }
                    if last_ble_write
                        .is_some_and(|last| last.elapsed() < Duration::from_millis(300))
                    {
                        return Err("操作过于频繁，请核对设备屏幕后再操作".into());
                    }
                    last_ble_write = Some(Instant::now());
                    transport.write(&action.encode())?;
                    Ok(BleCommandResult {
                        action,
                        sent_at: now_ms(),
                        device_confirmed: false,
                        message: format!(
                            "{}已发送；设备未提供执行确认，请核对 BW150 屏幕。",
                            action.label()
                        ),
                    })
                })();
                let mut s = state.lock().unwrap();
                log(
                    &mut s,
                    if result.is_ok() { "info" } else { "error" },
                    &format!(
                        "蓝牙{}：{}",
                        action.label(),
                        result
                            .as_ref()
                            .map(|r: &BleCommandResult| r.message.as_str())
                            .unwrap_or_else(|e: &String| e.as_str())
                    ),
                );
                let _ = reply.send(result);
            }
            Err(mpsc::TryRecvError::Disconnected) => break,
            Err(mpsc::TryRecvError::Empty) => {}
        }
        if !bluetooth {
            schedule.set_rate(Instant::now(), state.lock().unwrap().usb_sample_rate_hz);
            for kind in schedule.due_queries(Instant::now()) {
                transport.write(&atorch_protocol::query(1, kind))?;
            }
        }
        let timeout = if bluetooth {
            80
        } else {
            schedule.timeout_ms(Instant::now())
        };
        let n = transport.read(&mut buffer, timeout)?;
        if n > 0 {
            if bluetooth {
                for t in ble_decoder.push(&buffer[..n], now_ms()) {
                    accept_report(Report::Telemetry(t), state, samples, &mut recorder)?;
                    last_valid = Instant::now();
                }
            } else if accept(&buffer[..n], state, samples, &mut recorder)?.is_some() {
                last_valid = Instant::now();
            }
        }
        if last_valid.elapsed() > Duration::from_secs(5) {
            return Err(if bluetooth {
                "连续 5 秒未收到有效蓝牙数据，请检查设备蓝牙并重新连接"
            } else {
                "设备连续 5 秒未返回有效报文，请检查 USB 连接"
            }
            .into());
        }
    }
    recorder.flush()?;
    Ok(())
}
