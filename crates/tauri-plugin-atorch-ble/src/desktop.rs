//! Desktop GATT connection, with one bounded notification queue per connection.
use atorch_device::{DeviceInfo, Transport, TransportKind};
use btleplug::{
    api::{
        Central, CentralState, CharPropFlags, Manager as _, Peripheral as _, ScanFilter, WriteType,
    },
    platform::{Adapter, Manager, Peripheral},
};
use futures_util::StreamExt;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
    time::Duration,
};
use tokio::runtime::Runtime;
use uuid::Uuid;

const SERVICE: Uuid = Uuid::from_u128(0x0000ffe0_0000_1000_8000_00805f9b34fb);
const NOTIFY: Uuid = Uuid::from_u128(0x0000ffe1_0000_1000_8000_00805f9b34fb);

struct Desktop {
    runtime: Arc<Runtime>,
    scan: Mutex<()>,
    generation: AtomicU64,
    adapter: Mutex<Option<Adapter>>,
    devices: Mutex<HashMap<String, (DeviceInfo, Peripheral)>>,
}

fn service() -> Result<&'static Desktop, String> {
    static SERVICE: OnceLock<Result<Desktop, String>> = OnceLock::new();
    SERVICE
        .get_or_init(|| {
            Ok(Desktop {
                runtime: Arc::new(
                    tokio::runtime::Builder::new_multi_thread()
                        .worker_threads(2)
                        .thread_name("atorch-ble")
                        .enable_all()
                        .build()
                        .map_err(|e| e.to_string())?,
                ),
                scan: Mutex::new(()),
                generation: AtomicU64::new(0),
                adapter: Mutex::new(None),
                devices: Mutex::new(HashMap::new()),
            })
        })
        .as_ref()
        .map_err(Clone::clone)
}

async fn adapter(s: &Desktop) -> Result<Option<Adapter>, String> {
    if let Some(a) = s.adapter.lock().unwrap().clone() {
        return Ok(Some(a));
    }
    let manager = Manager::new()
        .await
        .map_err(|e| format!("无法访问系统蓝牙：{e}"))?;
    let found = manager
        .adapters()
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .next();
    *s.adapter.lock().unwrap() = found.clone();
    Ok(found)
}

pub fn status() -> Result<crate::BluetoothState, String> {
    let s = service()?;
    s.runtime.block_on(async {
        let a = adapter(s).await?;
        let enabled = if let Some(a) = &a {
            match a.adapter_state().await.map_err(|e| e.to_string())? {
                CentralState::PoweredOn => Some(true),
                CentralState::PoweredOff => Some(false),
                _ => None,
            }
        } else {
            None
        };
        Ok(crate::BluetoothState {
            supported: a.is_some(),
            enabled,
            permission: true,
            location_required: false,
            location_enabled: true,
        })
    })
}

pub fn stop_scan() -> Result<(), String> {
    let s = service()?;
    s.generation.fetch_add(1, Ordering::SeqCst);
    let a = s.adapter.lock().unwrap().clone();
    if let Some(a) = a {
        s.runtime
            .block_on(a.stop_scan())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn discover() -> Result<Vec<DeviceInfo>, String> {
    let s = service()?;
    let _scan = s.scan.try_lock().map_err(|_| "蓝牙扫描正在进行，请稍候")?;
    let generation = s.generation.fetch_add(1, Ordering::SeqCst) + 1;
    s.runtime.block_on(async {
        let a = adapter(s).await?.ok_or("未发现系统蓝牙适配器")?;
        if a.adapter_state().await.map_err(|e| e.to_string())? == CentralState::PoweredOff {
            return Err("请先在系统设置中开启蓝牙".into());
        }
        a.start_scan(ScanFilter::default())
            .await
            .map_err(|e| format!("无法扫描蓝牙：{e}"))?;
        for _ in 0..60 {
            if s.generation.load(Ordering::SeqCst) != generation {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let result = async {
            if s.generation.load(Ordering::SeqCst) != generation {
                return Ok(Vec::new());
            }
            let mut found = Vec::new();
            for peripheral in a.peripherals().await.map_err(|e| e.to_string())? {
                let Some(properties) = peripheral.properties().await.map_err(|e| e.to_string())?
                else {
                    continue;
                };
                let Some(name) = properties.local_name else {
                    continue;
                };
                if !name.to_ascii_uppercase().starts_with("BW150") {
                    continue;
                }
                let path = format!("ble://{}", peripheral.id());
                let info = DeviceInfo {
                    path: path.clone(),
                    name,
                    serial: String::new(),
                    vendor_id: 0,
                    product_id: 0,
                    transport: TransportKind::Bluetooth,
                    rssi: properties.rssi,
                };
                s.devices
                    .lock()
                    .unwrap()
                    .insert(path, (info.clone(), peripheral));
                found.push(info);
            }
            found.sort_by(|a, b| b.rssi.cmp(&a.rssi).then(a.path.cmp(&b.path)));
            Ok(found)
        }
        .await;
        let stopped = a.stop_scan().await.map_err(|e| e.to_string());
        result.and_then(|devices| stopped.map(|_| devices))
    })
}

pub fn open(path: &str) -> Result<(DeviceInfo, Box<dyn Transport>), String> {
    let s = service()?;
    let (info, peripheral) = s
        .devices
        .lock()
        .unwrap()
        .get(path)
        .cloned()
        .ok_or("请先扫描并选择 BW150 蓝牙设备")?;
    stop_scan()?;
    let runtime = s.runtime.clone();
    runtime.block_on(async {
        let result = tokio::time::timeout(Duration::from_secs(12), async {
            peripheral
                .connect()
                .await
                .map_err(|e| format!("蓝牙连接失败：{e}"))?;
            peripheral
                .discover_services()
                .await
                .map_err(|e| e.to_string())?;
            let characteristic = peripheral
                .characteristics()
                .into_iter()
                .find(|c| {
                    c.uuid == NOTIFY
                        && c.service_uuid == SERVICE
                        && c.properties
                            .contains(CharPropFlags::NOTIFY | CharPropFlags::WRITE)
                })
                .ok_or("此设备没有 BW150 的 FFE0 / FFE1 双向服务")?;
            let mut notifications = peripheral
                .notifications()
                .await
                .map_err(|e| e.to_string())?;
            peripheral
                .subscribe(&characteristic)
                .await
                .map_err(|e| format!("蓝牙通知订阅失败：{e}"))?;
            let (tx, rx) = mpsc::sync_channel(128);
            let failure = Arc::new(Mutex::new(None));
            let task_failure = failure.clone();
            let task = tokio::spawn(async move {
                while let Some(packet) = notifications.next().await {
                    if packet.uuid != NOTIFY || packet.value.is_empty() {
                        continue;
                    }
                    if packet.value.len() > 256 || tx.try_send(packet.value).is_err() {
                        *task_failure.lock().unwrap() =
                            Some("蓝牙接收缓冲区异常，请重新连接".into());
                        return;
                    }
                }
                *task_failure.lock().unwrap() = Some("蓝牙已断开，请重新连接".into());
            });
            Ok((characteristic, rx, failure, task))
        })
        .await
        .unwrap_or_else(|_| Err("蓝牙连接超时，请确认设备未被其他应用占用后重试".into()));
        match result {
            Ok((characteristic, rx, failure, task)) => Ok((
                info,
                Box::new(DesktopBle {
                    runtime: runtime.clone(),
                    peripheral: peripheral.clone(),
                    characteristic,
                    rx,
                    failure,
                    task,
                }) as Box<dyn Transport>,
            )),
            Err(error) => {
                let _ = tokio::time::timeout(Duration::from_secs(3), peripheral.disconnect()).await;
                Err(error)
            }
        }
    })
}

struct DesktopBle {
    runtime: Arc<Runtime>,
    peripheral: Peripheral,
    characteristic: btleplug::api::Characteristic,
    rx: mpsc::Receiver<Vec<u8>>,
    failure: Arc<Mutex<Option<String>>>,
    task: tokio::task::JoinHandle<()>,
}
impl Transport for DesktopBle {
    fn kind(&self) -> TransportKind {
        TransportKind::Bluetooth
    }
    fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        atorch_protocol::ble::validate_command(bytes)?;
        if let Some(error) = self.failure.lock().unwrap().clone() {
            return Err(error);
        }
        self.runtime
            .block_on(async {
                tokio::time::timeout(
                    Duration::from_secs(3),
                    self.peripheral
                        .write(&self.characteristic, bytes, WriteType::WithResponse),
                )
                .await
                .map_err(|_| "蓝牙写入超时，执行状态未知，请核对设备屏幕".to_string())?
                .map_err(|e| format!("蓝牙写入失败：{e}"))
            })
            .inspect_err(|error| {
                *self.failure.lock().unwrap() = Some(error.clone());
            })
    }
    fn read(&mut self, buffer: &mut [u8], timeout_ms: i32) -> Result<usize, String> {
        if let Some(error) = self.failure.lock().unwrap().clone() {
            return Err(error);
        }
        match self
            .rx
            .recv_timeout(Duration::from_millis(timeout_ms.clamp(1, 1000) as u64))
        {
            Ok(bytes) if bytes.len() <= buffer.len() => {
                buffer[..bytes.len()].copy_from_slice(&bytes);
                Ok(bytes.len())
            }
            Ok(_) => Err("蓝牙通知超过接收缓冲区".into()),
            Err(mpsc::RecvTimeoutError::Timeout) => Ok(0),
            Err(_) => Err("蓝牙已断开，请重新连接".into()),
        }
    }
}
impl Drop for DesktopBle {
    fn drop(&mut self) {
        self.task.abort();
        self.runtime.block_on(async {
            let _ = tokio::time::timeout(
                Duration::from_secs(3),
                self.peripheral.unsubscribe(&self.characteristic),
            )
            .await;
            let _ =
                tokio::time::timeout(Duration::from_secs(3), self.peripheral.disconnect()).await;
        });
    }
}
