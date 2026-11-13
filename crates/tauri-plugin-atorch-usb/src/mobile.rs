use atorch_device::{DeviceInfo, Transport};
use serde::Deserialize;
use serde_json::json;
use tauri::{plugin::PluginHandle, AppHandle, Manager, Runtime};

pub struct Usb<R: Runtime>(pub PluginHandle<R>);

#[derive(Deserialize)]
struct Devices {
    devices: Vec<DeviceInfo>,
}
#[derive(Deserialize)]
struct Read {
    data: Vec<u8>,
}

pub fn discover<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<DeviceInfo>, String> {
    app.state::<Usb<R>>()
        .0
        .run_mobile_plugin::<Devices>("discover", ())
        .map(|r| r.devices)
        .map_err(|e| e.to_string())
}

pub fn diagnostics<R: Runtime>(app: &AppHandle<R>) -> Result<crate::UsbDiagnostics, String> {
    app.state::<Usb<R>>()
        .0
        .run_mobile_plugin("diagnostics", ())
        .map_err(|e| e.to_string())
}

pub fn set_root_host<R: Runtime>(
    app: &AppHandle<R>,
    enabled: bool,
) -> Result<crate::RootUsbState, String> {
    app.state::<Usb<R>>()
        .0
        .run_mobile_plugin("rootUsbHost", json!({ "enabled": enabled }))
        .map_err(|e| e.to_string())
}

pub fn open<R: Runtime>(app: &AppHandle<R>, path: &str) -> Result<Box<dyn Transport>, String> {
    let handle = app.state::<Usb<R>>().0.clone();
    handle
        .run_mobile_plugin::<serde_json::Value>("open", json!({ "path": path }))
        .map_err(|e| e.to_string())?;
    struct AndroidUsb<R: Runtime>(PluginHandle<R>);
    impl<R: Runtime> Transport for AndroidUsb<R> {
        fn report_descriptor(&self) -> Result<Option<Vec<u8>>, String> {
            self.0
                .run_mobile_plugin::<Read>("reportDescriptor", ())
                .map(|r| Some(r.data))
                .map_err(|e| e.to_string())
        }
        fn write(&mut self, report: &[u8]) -> Result<(), String> {
            // USB Host addresses the interrupt endpoint directly, so there is no
            // Windows HIDAPI report-ID prefix here.
            self.0
                .run_mobile_plugin::<serde_json::Value>("write", json!({ "data": report }))
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        fn read(&mut self, buffer: &mut [u8], timeout_ms: i32) -> Result<usize, String> {
            let r: Read = self
                .0
                .run_mobile_plugin("read", json!({ "timeoutMs": timeout_ms }))
                .map_err(|e| e.to_string())?;
            if r.data.len() > buffer.len() {
                return Err("USB 报文长度超过接收缓冲区".into());
            }
            buffer[..r.data.len()].copy_from_slice(&r.data);
            Ok(r.data.len())
        }
    }
    impl<R: Runtime> Drop for AndroidUsb<R> {
        fn drop(&mut self) {
            let _ = self.0.run_mobile_plugin::<serde_json::Value>("close", ());
        }
    }
    Ok(Box::new(AndroidUsb(handle)))
}

pub struct AndroidFirmwareHost<R: Runtime>(pub AppHandle<R>);
impl<R: Runtime> atorch_device::firmware::FirmwareHost for AndroidFirmwareHost<R> {
    fn check_available(&self) -> Result<(), String> {
        Ok(())
    }
    fn discover(&self) -> Result<Vec<DeviceInfo>, String> {
        discover(&self.0)
    }
    fn profile(&self, info: &DeviceInfo) -> Result<bool, String> {
        #[derive(Deserialize)]
        struct Profile {
            iap: bool,
        }
        self.0
            .state::<Usb<R>>()
            .0
            .run_mobile_plugin::<Profile>("firmwareProfile", json!({"path":info.path}))
            .map(|p| p.iap)
            .map_err(|e| e.to_string())
    }
    fn open(&self, info: &DeviceInfo) -> Result<Box<dyn Transport>, String> {
        open(&self.0, &info.path)
    }
    fn begin(&self) -> Result<(), String> {
        self.0
            .state::<Usb<R>>()
            .0
            .run_mobile_plugin::<serde_json::Value>(
                "firmwareSession",
                json!({"enabled":true,"success":false}),
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    fn finish(&self, success: bool) -> Result<(), String> {
        self.0
            .state::<Usb<R>>()
            .0
            .run_mobile_plugin::<serde_json::Value>(
                "firmwareSession",
                json!({"enabled":false,"success":success}),
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

pub fn save_csv<R: Runtime>(
    app: &AppHandle<R>,
    name: &str,
    content: &str,
) -> Result<Option<String>, String> {
    #[derive(Deserialize)]
    struct Saved {
        uri: Option<String>,
    }
    app.state::<Usb<R>>()
        .0
        .run_mobile_plugin::<Saved>("saveCsv", json!({ "name": name, "content": content }))
        .map(|r| r.uri)
        .map_err(|e| e.to_string())
}

pub fn save_png<R: Runtime>(
    app: &AppHandle<R>,
    name: &str,
    data: &str,
) -> Result<Option<String>, String> {
    #[derive(Deserialize)]
    struct Saved {
        uri: Option<String>,
    }
    app.state::<Usb<R>>()
        .0
        .run_mobile_plugin::<Saved>("savePng", json!({ "name": name, "data": data }))
        .map(|r| r.uri)
        .map_err(|e| e.to_string())
}
