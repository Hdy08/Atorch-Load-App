use atorch_device::{discover, open_hid, DeviceManager};
use std::{thread, time::Duration};
fn main() -> Result<(), String> {
    let devices = discover()?;
    println!("{}", serde_json::to_string_pretty(&devices).unwrap());
    let Some(info) = devices.first() else {
        return Err("No ATORCH device found".into());
    };
    let manager = DeviceManager::default();
    manager.connect(info.clone(), open_hid(info)?, std::env::temp_dir())?;
    thread::sleep(Duration::from_secs(4));
    if std::env::args().any(|a| a == "--verify-command") {
        let before = manager.snapshot().settings.ok_or("No settings")?;
        let result = manager.command(atorch_protocol::Command {
            kind: "target".into(),
            value: before.target.ok_or("Current mode has no ordinary target")?,
            ..Default::default()
        });
        println!("Unchanged target command: {result:?}");
        result?;
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&manager.snapshot()).unwrap()
    );
    manager.disconnect();
    Ok(())
}
