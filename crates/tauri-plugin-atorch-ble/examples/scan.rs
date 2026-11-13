//! Read-only system BLE diagnostic. Does not connect or write characteristics.
#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use btleplug::{
        api::{Central, Manager as _, Peripheral as _, ScanFilter},
        platform::Manager,
    };
    let address = std::env::args().nth(1).unwrap_or_default();
    tokio::runtime::Runtime::new()?.block_on(async {
        for adapter in Manager::new().await?.adapters().await? {
            println!(
                "{}: {:?}",
                adapter.adapter_info().await?,
                adapter.adapter_state().await?
            );
            adapter.start_scan(ScanFilter::default()).await?;
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            let devices = adapter.peripherals().await?;
            let mut unnamed = 0;
            let mut matched = 0;
            for peripheral in &devices {
                if let Some(p) = peripheral.properties().await? {
                    unnamed += usize::from(p.local_name.is_none());
                    if p.local_name
                        .as_ref()
                        .is_some_and(|n| n.to_ascii_uppercase().starts_with("BW150"))
                        || (!address.is_empty()
                            && p.address.to_string().eq_ignore_ascii_case(&address))
                    {
                        matched += 1;
                        println!("{} {:?}", peripheral.id(), p);
                    }
                }
            }
            adapter.stop_scan().await?;
            println!(
                "devices={}, unnamed={unnamed}, matched={matched}",
                devices.len()
            );
        }
        Ok(())
    })
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn main() {}
