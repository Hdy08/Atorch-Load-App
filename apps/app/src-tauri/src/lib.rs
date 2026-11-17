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
fn get_system_accent(app: tauri::AppHandle) -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        use windows::UI::ViewManagement::{UIColorType, UISettings};
        let _ = app;
        let color = UISettings::new()
            .and_then(|settings| settings.GetColorValue(UIColorType::Accent))
            .map_err(|error| error.to_string())?;
        Ok(Some(format!(
            "#{:02x}{:02x}{:02x}",
            color.R, color.G, color.B
        )))
    }
    #[cfg(target_os = "android")]
    {
        tauri_plugin_atorch_usb::mobile::system_accent(&app).map(Some)
    }
    #[cfg(not(any(target_os = "windows", target_os = "android")))]
    {
        let _ = app;
        Ok(None)
    }
}

#[tauri::command]
fn get_system_theme() -> Result<Option<bool>, String> {
    #[cfg(target_os = "windows")]
    {
        use windows::UI::ViewManagement::{UIColorType, UISettings};
        let color = UISettings::new()
            .and_then(|settings| settings.GetColorValue(UIColorType::Background))
            .map_err(|error| error.to_string())?;
        Ok(Some(
            2 * u32::from(color.R) + 5 * u32::from(color.G) + u32::from(color.B) < 8 * 128,
        ))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(None)
    }
}

#[tauri::command]
fn set_window_theme(
    app: tauri::AppHandle,
    dark: bool,
    background: String,
    foreground: String,
    follow_system: bool,
) -> Result<bool, String> {
    #[cfg(desktop)]
    if let Some(window) = app.get_webview_window("main") {
        window
            .set_theme(if follow_system {
                None
            } else {
                Some(if dark {
                    tauri::Theme::Dark
                } else {
                    tauri::Theme::Light
                })
            })
            .map_err(|error| error.to_string())?;
        #[cfg(target_os = "windows")]
        {
            window
                .set_decorations(true)
                .map_err(|error| error.to_string())?;
            use windows::Win32::Graphics::Dwm::{
                DwmSetWindowAttribute, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
            };
            let hwnd = window.hwnd().map_err(|error| error.to_string())?;
            for (attribute, color) in [
                (DWMWA_CAPTION_COLOR, caption_color(&background)?),
                (DWMWA_TEXT_COLOR, caption_color(&foreground)?),
            ] {
                // Preserve the system caption buttons even if the OS does not
                // support custom caption colors. Theme changes remain native.
                let _ = unsafe {
                    DwmSetWindowAttribute(
                        hwnd,
                        attribute,
                        (&color as *const u32).cast(),
                        std::mem::size_of::<u32>() as u32,
                    )
                };
            }
        }
    }
    let _ = (app, dark, background, foreground, follow_system);
    Ok(false)
}

#[tauri::command]
fn window_action(app: tauri::AppHandle, action: String) -> Result<bool, String> {
    #[cfg(desktop)]
    if let Some(window) = app.get_webview_window("main") {
        match action.as_str() {
            "minimize" => window.minimize(),
            "maximize" => {
                if window.is_maximized().map_err(|error| error.to_string())? {
                    window.unmaximize()
                } else {
                    window.maximize()
                }
            }
            "close" => window.close(),
            "drag" => window.start_dragging(),
            "state" => Ok(()),
            _ => return Err("无效的窗口操作".into()),
        }
        .map_err(|error| error.to_string())?;
        return window.is_maximized().map_err(|error| error.to_string());
    }
    let _ = (app, action);
    Ok(false)
}

#[cfg(target_os = "windows")]
fn caption_color(hex: &str) -> Result<u32, String> {
    if hex.len() != 7 || !hex.starts_with('#') {
        return Err("无效的窗口主题颜色".into());
    }
    let rgb = u32::from_str_radix(&hex[1..], 16).map_err(|_| "无效的窗口主题颜色")?;
    // DWM accepts COLORREF (0x00BBGGRR), whereas Fluent tokens use #RRGGBB.
    Ok(((rgb & 0xff0000) >> 16) | (rgb & 0x00ff00) | ((rgb & 0x0000ff) << 16))
}

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
fn set_auto_record_on_load(manager: State<'_, Devices>, enabled: bool) -> Result<(), String> {
    manager.set_auto_record_on_load(enabled)
}
#[tauri::command]
fn set_auto_recording(
    manager: State<'_, Devices>,
    settings: atorch_device::auto_recording::Settings,
) -> Result<(), String> {
    manager.set_auto_recording(settings)
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
        return Err("请选择不超过 1,024,000 字节的 .bin 固件文件".into());
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
        let mut info = firmware_image(&name, &data_base64)?.info;
        info.hardware_write_available = cfg!(any(target_os = "windows", target_os = "android"));
        info.limitation = if info.hardware_write_available {
            String::new()
        } else {
            "实机刷写目前支持 Windows / Android USB；此平台可使用离线预演。".into()
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
async fn open_firmware_log(
    app: tauri::AppHandle,
    manager: State<'_, Devices>,
) -> Result<(), String> {
    // The frontend supplies no path: only the current native job's log can open.
    let log_path = manager
        .snapshot()
        .firmware
        .map(|job| job.log_path)
        .filter(|path| !path.is_empty())
        .ok_or("尚无传输日志")?;
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("firmware_logs");
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(log_path)
            .canonicalize()
            .map_err(|e| format!("无法读取传输日志：{e}"))?;
        let directory = directory.canonicalize().map_err(|e| e.to_string())?;
        if path.parent() != Some(directory.as_path())
            || path.extension().and_then(|extension| extension.to_str()) != Some("jsonl")
            || !path.is_file()
        {
            return Err("无效的传输日志文件".into());
        }
        #[cfg(target_os = "android")]
        {
            tauri_plugin_atorch_usb::mobile::open_firmware_log(&app, &path.to_string_lossy())
        }
        #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
        {
            #[cfg(target_os = "windows")]
            let mut command = std::process::Command::new("notepad.exe");
            #[cfg(target_os = "macos")]
            let mut command = {
                let mut command = std::process::Command::new("open");
                command.arg("-t");
                command
            };
            #[cfg(target_os = "linux")]
            let mut command = std::process::Command::new("xdg-open");
            command
                .arg(path)
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("无法打开传输日志：{e}"))
        }
        #[cfg(not(any(
            target_os = "windows",
            target_os = "android",
            target_os = "macos",
            target_os = "linux"
        )))]
        Err("当前平台不支持打开传输日志".into())
    })
    .await
    .map_err(|e| e.to_string())?
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
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                window.with_webview(|webview| {
                    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
                    use windows::core::Interface;
                    let configure = || -> windows::core::Result<()> {
                        unsafe {
                            let settings = webview.controller().CoreWebView2()?.Settings()?;
                            settings.SetAreDefaultContextMenusEnabled(false)?;
                            settings.SetAreDevToolsEnabled(false)?;
                            settings.SetIsZoomControlEnabled(false)?;
                            settings
                                .cast::<ICoreWebView2Settings3>()?
                                .SetAreBrowserAcceleratorKeysEnabled(false)?;
                        }
                        Ok(())
                    };
                    if let Err(error) = configure() {
                        eprintln!("WebView input preferences: {error}");
                    }
                })?;
            }
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
            get_system_accent,
            get_system_theme,
            set_window_theme,
            window_action,
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
            set_auto_record_on_load,
            set_auto_recording,
            set_usb_sample_rate,
            clear_samples,
            send_command,
            send_ble_command,
            inspect_firmware,
            rehearse_firmware,
            start_firmware,
            cancel_firmware,
            open_firmware_log,
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
