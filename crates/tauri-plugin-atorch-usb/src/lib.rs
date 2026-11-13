//! Android USB Host transport. Protocol parsing and command scheduling stay in Rust.
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "android")]
pub mod mobile;

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbDiagnostics {
    pub host_supported: bool,
    pub devices: Vec<UsbDeviceDiagnostic>,
    #[serde(default)]
    pub root_usb: Option<RootUsbState>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootUsbState {
    pub supported: bool,
    pub enabled: bool,
    pub restore_pending: bool,
    pub error: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbDeviceDiagnostic {
    pub path: String,
    pub name: String,
    pub vendor_id: u16,
    pub product_id: u16,
    pub supported: bool,
    pub permission: bool,
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("atorch-usb")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                app.manage(mobile::Usb(
                    api.register_android_plugin("dev.atorch.usb", "UsbPlugin")?,
                ));
            }
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}
