use atorch_device::record_library::{Library, RecordingInfo};
use atorch_device::{DeviceInfo, DeviceManager, Sample, Snapshot};
use atorch_protocol::Command;
use base64::Engine;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{Manager, State};

type Devices = Arc<DeviceManager>;
type RecordLibrary = Arc<Mutex<Library>>;

#[tauri::command]
async fn set_chart_fullscreen(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            tauri_plugin_atorch_usb::mobile::set_chart_fullscreen(&app, enabled)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, enabled);
        Ok(())
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CsvDocument {
    path: String,
    name: String,
    bytes: u64,
    modified_at: u64,
    data_base64: String,
}

impl CsvDocument {
    fn info(&self) -> RecordingInfo {
        RecordingInfo {
            id: self.path.clone(),
            path: self.path.clone(),
            name: self.name.clone(),
            bytes: self.bytes,
            modified_at: self.modified_at,
        }
    }
}

fn read_csv_document(app: &tauri::AppHandle, path: &str) -> Result<CsvDocument, String> {
    #[cfg(target_os = "android")]
    {
        tauri_plugin_atorch_usb::mobile::read_document(app, path)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        let (info, bytes) = atorch_device::record_library::read_file(std::path::Path::new(path))?;
        Ok(CsvDocument {
            path: info.path,
            name: info.name,
            bytes: info.bytes,
            modified_at: info.modified_at,
            data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        })
    }
}

#[tauri::command]
async fn get_bluetooth_status(
    app: tauri::AppHandle,
) -> Result<Option<tauri_plugin_atorch_ble::BluetoothState>, String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            tauri_plugin_atorch_ble::mobile::status(&app).map(Some)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        let _ = app;
        tauri::async_runtime::spawn_blocking(|| {
            tauri_plugin_atorch_ble::desktop::status().map(Some)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(any(
        target_os = "android",
        target_os = "windows",
        target_os = "macos",
        target_os = "linux"
    )))]
    {
        let _ = app;
        Ok(None)
    }
}
#[tauri::command]
async fn discover_bluetooth(app: tauri::AppHandle) -> Result<Vec<DeviceInfo>, String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            tauri_plugin_atorch_ble::mobile::discover(&app)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        let _ = app;
        tauri::async_runtime::spawn_blocking(tauri_plugin_atorch_ble::desktop::discover)
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(any(
        target_os = "android",
        target_os = "windows",
        target_os = "macos",
        target_os = "linux"
    )))]
    {
        let _ = app;
        Err("此平台尚未提供蓝牙连接".into())
    }
}
#[tauri::command]
async fn stop_bluetooth_scan(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            tauri_plugin_atorch_ble::mobile::stop_scan(&app)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        let _ = app;
        tauri::async_runtime::spawn_blocking(tauri_plugin_atorch_ble::desktop::stop_scan)
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(not(any(
        target_os = "android",
        target_os = "windows",
        target_os = "macos",
        target_os = "linux"
    )))]
    {
        let _ = app;
        Ok(())
    }
}

#[tauri::command]
async fn set_root_usb_host(
    app: tauri::AppHandle,
    manager: State<'_, Devices>,
    enabled: bool,
) -> Result<tauri_plugin_atorch_usb::RootUsbState, String> {
    #[cfg(target_os = "android")]
    {
        let manager = manager.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            if enabled && manager.snapshot().connected {
                return Err("请先断开当前设备，再启用 Root USB-C 直连".into());
            }
            if !enabled {
                manager.disconnect();
            }
            tauri_plugin_atorch_usb::mobile::set_root_host(&app, enabled)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, manager, enabled);
        Err("Root USB-C 直连仅用于 Android".into())
    }
}

#[tauri::command]
async fn get_usb_diagnostics(
    app: tauri::AppHandle,
) -> Result<Option<tauri_plugin_atorch_usb::UsbDiagnostics>, String> {
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            tauri_plugin_atorch_usb::mobile::diagnostics(&app).map(Some)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(None)
    }
}

fn record_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("recordings"))
}

#[tauri::command]
async fn discover_devices(app: tauri::AppHandle) -> Result<Vec<DeviceInfo>, String> {
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        tauri::async_runtime::spawn_blocking(atorch_device::discover)
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(target_os = "android")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            tauri_plugin_atorch_usb::mobile::discover(&app)
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

#[tauri::command]
async fn connect_device(
    app: tauri::AppHandle,
    manager: State<'_, Devices>,
    path: String,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    let dir = record_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        if manager.firmware_active() {
            return Err("固件升级正在独占 USB，请等待完成".into());
        }
        manager.disconnect();
        #[cfg(not(target_os = "android"))]
        {
            #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
            if path.starts_with("ble://") {
                let (info, transport) = tauri_plugin_atorch_ble::desktop::open(&path)?;
                return manager.connect(info, transport, dir);
            }
            let info = atorch_device::discover()?
                .into_iter()
                .find(|d| d.path == path)
                .ok_or("设备已移除，请重新扫描")?;
            let transport = atorch_device::open_hid(&info)?;
            manager.connect(info, transport, dir)
        }
        #[cfg(target_os = "android")]
        {
            if path.starts_with("ble://") {
                let (info, transport) = tauri_plugin_atorch_ble::mobile::open(&app, &path)?;
                return manager.connect(info, transport, dir);
            }
            let info = tauri_plugin_atorch_usb::mobile::discover(&app)?
                .into_iter()
                .find(|d| d.path == path)
                .ok_or("设备已移除，请重新扫描")?;
            let transport = tauri_plugin_atorch_usb::mobile::open(&app, &path)?;
            manager.connect(info, transport, dir)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn disconnect_device(manager: State<'_, Devices>) -> Result<(), String> {
    if manager.firmware_active() {
        return Err("固件升级期间不能断开 USB".into());
    }
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.disconnect())
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn get_snapshot(manager: State<'_, Devices>) -> Snapshot {
    manager.snapshot()
}
#[tauri::command]
fn get_history(manager: State<'_, Devices>) -> Vec<Sample> {
    manager.samples()
}
#[tauri::command]
fn set_sampling(manager: State<'_, Devices>, enabled: bool) -> Result<(), String> {
    manager.set_sampling(enabled)
}
#[tauri::command]
fn set_usb_sample_rate(manager: State<'_, Devices>, hz: u8) -> Result<(), String> {
    manager.set_usb_sample_rate(hz)
}
#[tauri::command]
fn clear_samples(manager: State<'_, Devices>) -> Result<(), String> {
    manager.clear_samples()
}
#[tauri::command]
async fn send_command(manager: State<'_, Devices>, command: Command) -> Result<(), String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.command(command))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn send_ble_command(
    manager: State<'_, Devices>,
    action: atorch_protocol::ble::Command,
) -> Result<atorch_device::BleCommandResult, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.ble_command(action))
        .await
        .map_err(|e| e.to_string())?
}

fn firmware_image(name: &str, encoded: &str) -> Result<atorch_protocol::firmware::Image, String> {
    if name.len() > 255
        || name.contains(['/', '\\'])
        || !name.to_ascii_lowercase().ends_with(".bin")
        || encoded.len() > atorch_protocol::firmware::MAX_IMAGE_SIZE.div_ceil(3) * 4
    {
        return Err("请选择大小在协议范围内的 .bin 固件文件".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "固件编码无效")?;
    atorch_protocol::firmware::Image::inspect(name, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
async fn inspect_firmware(
    name: String,
    data_base64: String,
) -> Result<atorch_protocol::firmware::FirmwareInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let image=firmware_image(&name,&data_base64)?;
        let mut info=image.info;
        let verified=info.sha256==atorch_protocol::firmware::legacy::BW150_IMAGE_SHA256;
        info.hardware_write_available=cfg!(any(target_os="windows",target_os="android"))&&verified;
        info.limitation=if verified {
            "已核准 BW150 V1.1.0 原厂文件；Windows / Android 可通过 USB 升级或从 IAP V1.0.2 重新传输，需核对接口及描述符。".into()
        }else{
            "此文件尚未完成实机传输及型号核准；可检查和离线预演，不能实机刷写。".into()
        };
        Ok(info)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn rehearse_firmware(
    name: String,
    data_base64: String,
) -> Result<atorch_protocol::firmware::Rehearsal, String> {
    // Deliberately has no DeviceManager or transport: rehearsal cannot reboot,
    // erase, flash, or interrupt a connected device/recording.
    tauri::async_runtime::spawn_blocking(move || {
        let image = firmware_image(&name, &data_base64)?;
        atorch_protocol::firmware::rehearse(image).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn set_recording(manager: State<'_, Devices>, enabled: bool) -> Result<(), String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.record(if enabled { Some(PathBuf::new()) } else { None })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn start_firmware(
    app: tauri::AppHandle,
    manager: State<'_, Devices>,
    path: String,
    name: String,
    data_base64: String,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("firmware_logs");
    tauri::async_runtime::spawn_blocking(move || {
        let image = firmware_image(&name, &data_base64)?;
        #[cfg(target_os = "android")]
        {
            manager.start_firmware_with_host(
                path,
                image,
                directory,
                Arc::new(tauri_plugin_atorch_usb::mobile::AndroidFirmwareHost(app)),
            )
        }
        #[cfg(not(target_os = "android"))]
        {
            manager.start_firmware(path, image, directory)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn cancel_firmware(manager: State<'_, Devices>) -> Result<(), String> {
    manager.cancel_firmware()
}
#[tauri::command]
async fn export_csv(
    app: tauri::AppHandle,
    manager: State<'_, Devices>,
    library: State<'_, RecordLibrary>,
) -> Result<String, String> {
    let dir = record_dir(&app)?;
    let samples = manager.samples();
    let library = library.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if samples.is_empty() {
            return Err("暂无可导出的数据".into());
        }
        #[cfg(target_os = "android")]
        {
            let _ = dir;
            let path = tauri_plugin_atorch_usb::mobile::save_csv(
                &app,
                &format!("Atorch_{}.csv", atorch_device::now_ms()),
                &atorch_device::csv(&samples),
            )?
            .ok_or("已取消导出")?;
            let document = read_csv_document(&app, &path)?;
            library
                .lock()
                .map_err(|e| e.to_string())?
                .register(document.info())?;
            Ok(path)
        }
        #[cfg(not(target_os = "android"))]
        {
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let path = dir.join(format!("BW150_export_{}.csv", atorch_device::now_ms()));
            std::fs::write(&path, atorch_device::csv(&samples)).map_err(|e| e.to_string())?;
            let document = read_csv_document(&app, &path.to_string_lossy())?;
            library
                .lock()
                .map_err(|e| e.to_string())?
                .register(document.info())?;
            Ok(path.to_string_lossy().into())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_csv(
    app: tauri::AppHandle,
    library: State<'_, RecordLibrary>,
    name: String,
    content: String,
) -> Result<Option<String>, String> {
    if !atorch_device::recordings::valid_filename(&name, ".csv") || content.len() > 50_000_000 {
        return Err("导出文件名或数据大小无效".into());
    }
    let library = library.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "android")]
        let path = tauri_plugin_atorch_usb::mobile::save_csv(&app, &name, &content)?;
        #[cfg(not(target_os = "android"))]
        let path = save_document(&app, &name, "CSV 文件", "csv", content.as_bytes())?;
        if let Some(path) = &path {
            let document = read_csv_document(&app, path)?;
            library
                .lock()
                .map_err(|e| e.to_string())?
                .register(document.info())
                .map_err(|e| format!("CSV 已保存至 {path}，但记录库登记失败：{e}"))?;
        }
        Ok(path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_recordings(library: State<'_, RecordLibrary>) -> Result<Vec<RecordingInfo>, String> {
    let library = library.inner().clone();
    tauri::async_runtime::spawn_blocking(move || library.lock().map_err(|e| e.to_string())?.list())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn read_recording(
    app: tauri::AppHandle,
    library: State<'_, RecordLibrary>,
    id: String,
) -> Result<CsvDocument, String> {
    let library = library.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let entry = library.lock().map_err(|e| e.to_string())?.find(&id)?;
        read_csv_document(&app, &entry.path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn open_csv(app: tauri::AppHandle) -> Result<Option<CsvDocument>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "android")]
        {
            tauri_plugin_atorch_usb::mobile::open_csv(&app)
        }
        #[cfg(not(target_os = "android"))]
        {
            let mut dialog = rfd::FileDialog::new()
                .set_title("导入 CSV")
                .add_filter("CSV 文件", &["csv"]);
            if let Some(window) = app.get_webview_window("main") {
                dialog = dialog.set_parent(&window);
            }
            dialog
                .pick_file()
                .map(|path| read_csv_document(&app, &path.to_string_lossy()))
                .transpose()
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn register_recording(
    app: tauri::AppHandle,
    library: State<'_, RecordLibrary>,
    path: String,
) -> Result<RecordingInfo, String> {
    let library = library.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let document = read_csv_document(&app, &path)?;
        library
            .lock()
            .map_err(|e| e.to_string())?
            .register(document.info())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn delete_recordings(
    library: State<'_, RecordLibrary>,
    ids: Vec<String>,
) -> Result<(), String> {
    let library = library.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        library.lock().map_err(|e| e.to_string())?.remove(&ids)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_png(
    app: tauri::AppHandle,
    name: String,
    data_url: String,
) -> Result<Option<String>, String> {
    if !atorch_device::recordings::valid_filename(&name, ".png") || data_url.len() > 12_000_000 {
        return Err("图片文件名或数据大小无效".into());
    }
    let encoded = data_url
        .strip_prefix("data:image/png;base64,")
        .ok_or("无效的 PNG 图片数据")?
        .to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let data = base64::engine::general_purpose::STANDARD
            .decode(&encoded)
            .map_err(|_| "无效的 PNG 编码")?;
        if !data.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err("无效的 PNG 文件".into());
        }
        #[cfg(target_os = "android")]
        {
            tauri_plugin_atorch_usb::mobile::save_png(&app, &name, &encoded)
        }
        #[cfg(not(target_os = "android"))]
        {
            save_document(&app, &name, "PNG 图片", "png", &data)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(not(target_os = "android"))]
fn save_document(
    app: &tauri::AppHandle,
    name: &str,
    label: &str,
    extension: &str,
    bytes: &[u8],
) -> Result<Option<String>, String> {
    let mut dialog = rfd::FileDialog::new()
        .set_title("另存为")
        .set_file_name(name)
        .add_filter(label, &[extension]);
    if let Ok(directory) = app.path().document_dir() {
        dialog = dialog.set_directory(directory);
    }
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let Some(path) = dialog.save_file() else {
        return Ok(None);
    };
    std::fs::write(&path, bytes).map_err(|e| format!("文件保存失败：{e}"))?;
    Ok(Some(path.to_string_lossy().into()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();
    #[cfg(all(debug_assertions, target_os = "windows"))]
    if let Ok(port) = std::env::var("ATORCH_DEBUG_PORT") {
        if let Ok(port) = port.parse::<u16>() {
            context.config_mut().app.windows[0].additional_browser_args =
                Some(format!("--remote-debugging-port={port}"));
        }
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_atorch_usb::init())
        .plugin(tauri_plugin_atorch_ble::init())
        .setup(|app| {
            let path = app.path().app_config_dir()?.join("sampling.json");
            app.manage(Arc::new(DeviceManager::with_sampling_preferences(path)));
            let index = app.path().app_config_dir()?.join("record-library.json");
            app.manage(Arc::new(Mutex::new(Library::new(index))));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.state::<Devices>().firmware_active() {
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            set_chart_fullscreen,
            discover_devices,
            get_bluetooth_status,
            discover_bluetooth,
            stop_bluetooth_scan,
            get_usb_diagnostics,
            set_root_usb_host,
            connect_device,
            disconnect_device,
            get_snapshot,
            get_history,
            set_sampling,
            set_usb_sample_rate,
            clear_samples,
            send_command,
            send_ble_command,
            inspect_firmware,
            rehearse_firmware,
            start_firmware,
            cancel_firmware,
            set_recording,
            export_csv,
            save_csv,
            save_png,
            list_recordings,
            read_recording,
            open_csv,
            register_recording,
            delete_recordings
        ])
        .run(context)
        .expect("failed to run Atorch Load");
}
