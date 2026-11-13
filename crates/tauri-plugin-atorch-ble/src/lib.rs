//! BLE GATT transports; application protocol and command whitelist remain in Rust.
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothState {
    pub supported: bool,
    pub enabled: Option<bool>,
    pub permission: bool,
    pub location_required: bool,
    pub location_enabled: bool,
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
pub mod desktop;
#[cfg(target_os = "android")]
pub mod mobile;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("atorch-ble")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                app.manage(mobile::Bluetooth(
                    api.register_android_plugin("dev.atorch.ble", "BlePlugin")?,
                ));
            }
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}
