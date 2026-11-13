//! Read-only USB metadata and descriptor inventory; no report writes.
#[cfg(not(target_os = "android"))]
fn main() {
    let api = hidapi::HidApi::new().unwrap();
    for device in api
        .device_list()
        .filter(|d| d.vendor_id() == 0x0483 && d.product_id() == 0x5750)
    {
        let result = device.open_device(&api).and_then(|hid| {
            let mut bytes = [0; 512];
            let n = hid.get_report_descriptor(&mut bytes)?;
            Ok(atorch_protocol::firmware::hex(&bytes[..n]))
        });
        println!(
            "{}",
            serde_json::json!({
                "path":device.path().to_string_lossy(),"manufacturer":device.manufacturer_string(),
                "product":device.product_string(),"serial":device.serial_number(),
                "usagePage":device.usage_page(),"usage":device.usage(),"descriptor":result.map_err(|e| e.to_string()),
            })
        );
    }
}
#[cfg(target_os = "android")]
fn main() {
    eprintln!("Use the Android USB plugin for descriptor inventory");
}
