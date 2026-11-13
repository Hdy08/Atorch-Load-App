use atorch_device::{DeviceInfo, Transport, TransportKind};
use serde::Deserialize;
use serde_json::json;
use tauri::{plugin::PluginHandle, AppHandle, Manager, Runtime};

pub struct Bluetooth<R: Runtime>(pub PluginHandle<R>);
#[derive(Deserialize)]
struct Devices {
    devices: Vec<DeviceInfo>,
}
#[derive(Deserialize)]
struct Read {
    data: Vec<u8>,
}

pub fn status<R: Runtime>(app: &AppHandle<R>) -> Result<crate::BluetoothState, String> {
    app.state::<Bluetooth<R>>()
        .0
        .run_mobile_plugin("status", ())
        .map_err(|e| e.to_string())
}
pub fn discover<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<DeviceInfo>, String> {
    app.state::<Bluetooth<R>>()
        .0
        .run_mobile_plugin::<Devices>("scan", ())
        .map(|r| r.devices)
        .map_err(|e| e.to_string())
}
pub fn stop_scan<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    app.state::<Bluetooth<R>>()
        .0
        .run_mobile_plugin::<serde_json::Value>("stopScan", ())
        .map(|_| ())
        .map_err(|e| e.to_string())
}
pub fn open<R: Runtime>(
    app: &AppHandle<R>,
    path: &str,
) -> Result<(DeviceInfo, Box<dyn Transport>), String> {
    let handle = app.state::<Bluetooth<R>>().0.clone();
    let info: DeviceInfo = handle
        .run_mobile_plugin("open", json!({"path":path}))
        .map_err(|e| e.to_string())?;
    struct AndroidBle<R: Runtime>(PluginHandle<R>);
    impl<R: Runtime> Transport for AndroidBle<R> {
        fn kind(&self) -> TransportKind {
            TransportKind::Bluetooth
        }
        fn write(&mut self, report: &[u8]) -> Result<(), String> {
            atorch_protocol::ble::validate_command(report)?;
            self.0
                .run_mobile_plugin::<serde_json::Value>("write", json!({"data":report}))
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        fn read(&mut self, buffer: &mut [u8], timeout: i32) -> Result<usize, String> {
            let result: Read = self
                .0
                .run_mobile_plugin("read", json!({"timeoutMs":timeout}))
                .map_err(|e| e.to_string())?;
            if result.data.len() > buffer.len() {
                return Err("蓝牙通知超过接收缓冲区".into());
            }
            buffer[..result.data.len()].copy_from_slice(&result.data);
            Ok(result.data.len())
        }
    }
    impl<R: Runtime> Drop for AndroidBle<R> {
        fn drop(&mut self) {
            let _ = self.0.run_mobile_plugin::<serde_json::Value>("close", ());
        }
    }
    Ok((info, Box::new(AndroidBle(handle))))
}
