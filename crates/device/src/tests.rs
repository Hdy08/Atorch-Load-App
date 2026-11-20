use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
type CapturedWrites = Arc<Mutex<Vec<Vec<u8>>>>;

struct FakeUsb {
    pending: VecDeque<[u8; 64]>,
    settings: [u8; 64],
    writes: Arc<Mutex<Vec<Vec<u8>>>>,
    removed: Arc<AtomicBool>,
    readback: bool,
    acknowledge_parameters: bool,
    running: bool,
    panel_running: Option<Arc<AtomicBool>>,
    status: u8,
    stage: u8,
}
impl Transport for FakeUsb {
    fn write(&mut self, report: &[u8]) -> Result<(), String> {
        self.writes.lock().unwrap().push(report.to_vec());
        match report[3] {
            3 => self.pending.push_back(self.settings),
            5 => {
                let mut t = [0; 64];
                t[..4].copy_from_slice(&[0xaa, 5, 1, 5]);
                t[62..].copy_from_slice(&[0xee, 0xff]);
                t[52] = self
                    .panel_running
                    .as_ref()
                    .map_or(self.running, |v| v.load(Ordering::Relaxed))
                    as u8;
                t[53] = self.status;
                t[54] = self.stage;
                self.pending.push_back(t);
            }
            0x21 if self.readback => self.settings[4..8].copy_from_slice(&report[4..8]),
            0x22 if self.readback => self.settings[50] = report[7],
            0x23 if self.readback => self.settings[51] = report[7],
            0x24 if self.readback => self.settings[52] = report[7],
            0x26 if self.readback => self.settings[8..12].copy_from_slice(&report[4..8]),
            0x29 if self.readback => self.settings[20..24].copy_from_slice(&report[4..8]),
            0x2a if self.readback => self.settings[24..28].copy_from_slice(&report[4..8]),
            0x2b if self.readback => self.settings[28..32].copy_from_slice(&report[4..8]),
            0x2c if self.readback => self.settings[32..36].copy_from_slice(&report[4..8]),
            0x2d if self.readback => self.settings[36..40].copy_from_slice(&report[4..8]),
            0x2e if self.readback => self.settings[40..44].copy_from_slice(&report[4..8]),
            0x2f if self.readback => self.settings[44..48].copy_from_slice(&report[4..8]),
            0x31 if self.readback => match report[7] {
                1 => self.settings[53] = report[4],
                2 => self.settings[54] = report[4],
                _ => {}
            },
            0x37 if self.readback => self.settings[55] = report[7],
            0x21..=0x31 if self.acknowledge_parameters => {
                let mut ack = [0; 64];
                ack[..5].copy_from_slice(&[0xaa, 5, 1, 4, 1]);
                ack[8..10].copy_from_slice(&[0xee, 0xff]);
                self.pending.push_back(ack);
            }
            0x25 if self.readback => self.running = report[4] == 1,
            0x35 => {
                let mut ack = [0; 64];
                ack[..5].copy_from_slice(&[0xaa, 5, 1, 4, 1]);
                ack[8..10].copy_from_slice(&[0xee, 0xff]);
                self.pending.push_back(ack);
                if self.readback {
                    self.running = matches!(report[4], 2 | 3);
                    self.status = 0;
                    self.stage = 0;
                }
            }
            0x47..=0x50 => {
                let mut ack = [0; 64];
                ack[..5].copy_from_slice(&[0xaa, 5, 1, 4, 1]);
                ack[8..10].copy_from_slice(&[0xee, 0xff]);
                self.pending.push_back(ack);
                if self.readback {
                    self.settings[48] = report[3] - 0x47;
                }
            }
            _ => {}
        }
        Ok(())
    }
    fn read(&mut self, buffer: &mut [u8], timeout: i32) -> Result<usize, String> {
        if self.removed.load(Ordering::Relaxed) {
            return Err("USB removed".into());
        }
        if let Some(report) = self.pending.pop_front() {
            buffer[..64].copy_from_slice(&report);
            return Ok(64);
        }
        thread::sleep(Duration::from_millis(timeout.clamp(1, 5) as u64));
        Ok(0)
    }
}
fn fake(readback: bool) -> (Box<FakeUsb>, CapturedWrites, Arc<AtomicBool>) {
    let writes = Arc::new(Mutex::new(Vec::new()));
    let removed = Arc::new(AtomicBool::new(false));
    let mut settings = [0; 64];
    settings[..4].copy_from_slice(&[0xaa, 5, 1, 3]);
    settings[4..8].copy_from_slice(&3.3f32.to_be_bytes());
    settings[32..36].copy_from_slice(&20f32.to_be_bytes());
    settings[36..40].copy_from_slice(&400f32.to_be_bytes());
    settings[53] = 2;
    settings[62..].copy_from_slice(&[0xee, 0xff]);
    (
        Box::new(FakeUsb {
            pending: VecDeque::new(),
            settings,
            writes: Arc::clone(&writes),
            removed: Arc::clone(&removed),
            readback,
            acknowledge_parameters: false,
            running: false,
            panel_running: None,
            status: 0,
            stage: 0,
        }),
        writes,
        removed,
    )
}
fn connect(transport: Box<dyn Transport>) -> DeviceManager {
    connect_named(transport, "test")
}
fn connect_named(transport: Box<dyn Transport>, name: &str) -> DeviceManager {
    let manager = DeviceManager::default();
    manager
        .connect(
            DeviceInfo {
                path: "fake".into(),
                name: name.into(),
                serial: "".into(),
                vendor_id: 0,
                product_id: 0,
                transport: transport.kind(),
                rssi: None,
            },
            transport,
            std::env::temp_dir(),
        )
        .unwrap();
    wait(|| manager.snapshot().settings.is_some());
    wait(|| manager.snapshot().telemetry.is_some());
    manager
}
fn wait(mut predicate: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(4);
    while !predicate() {
        assert!(Instant::now() < end, "worker did not reach expected state");
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn dl24_accepts_load_modes_and_discharge_settings_but_rejects_charging_writes() {
    let (usb, writes, _) = fake(true);
    let manager = connect_named(usb, "ATORCH DL24 V1.1.0");
    let send = |kind: &str, value| {
        manager.command(Command {
            kind: kind.into(),
            value,
            ..Default::default()
        })
    };
    for mode in [1, 2, 3, 0] {
        send("mode", f64::from(mode)).unwrap();
        assert_eq!(manager.snapshot().settings.unwrap().mode, mode);
    }
    send("cutoffVoltage", 2.5).unwrap();
    assert_eq!(manager.snapshot().settings.unwrap().cutoff_voltage, 2.5);
    let count = writes.lock().unwrap().len();
    for (kind, value) in [
        ("mode", 4.0),
        ("mode", 7.0),
        ("fullVoltage", 4.2),
        ("cutoffCurrent", 0.05),
        ("stage", 5.0),
    ] {
        let error = send(kind, value).unwrap_err();
        assert!(error.starts_with("DL24"), "{error}");
    }
    assert!(writes.lock().unwrap()[count..]
        .iter()
        .all(|frame| matches!(frame[3], 3 | 5)));
}

#[test]
fn bw600_controls_use_device_protection_and_extended_ranges() {
    let (mut usb, writes, _) = fake(true);
    usb.settings[32..36].copy_from_slice(&30f32.to_be_bytes());
    usb.settings[36..40].copy_from_slice(&600f32.to_be_bytes());
    let manager = connect_named(usb, "ATORCH BW600 V2.0.5");
    let send = |kind: &str, value| {
        manager.command(Command {
            kind: kind.into(),
            value,
            ..Default::default()
        })
    };
    send("target", 25.0).unwrap();
    assert!(send("target", 31.0).is_err());
    send("mode", 1.0).unwrap();
    send("target", 150.0).unwrap();
    assert!(send("target", 201.0).is_err());
    send("mode", 3.0).unwrap();
    send("target", 500.0).unwrap();
    assert!(send("target", 601.0).is_err());
    assert!(send("overPower", 1201.0).is_err());
    assert!(send("overCurrent", 50.1).is_err());
    assert_eq!(
        writes
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r[3] == 0x21)
            .count(),
        3
    );
}

#[test]
fn bw600_cycle_configuration_and_start_require_the_supported_firmware_readback() {
    for (version, byte) in [("V2.0.5", 10), ("V2.0.3", 0x66)] {
        let (mut usb, writes, _) = fake(true);
        usb.settings[20..24].copy_from_slice(&2.5f32.to_be_bytes());
        usb.settings[24..28].copy_from_slice(&4.2f32.to_be_bytes());
        usb.settings[28..32].copy_from_slice(&0.05f32.to_be_bytes());
        usb.settings[55] = byte;
        let manager = connect_named(usb, &format!("ATORCH BW600 {version}"));
        let send = |kind: &str, value, expected_mode| {
            manager.command(Command {
                kind: kind.into(),
                value,
                expected_mode,
                ..Default::default()
            })
        };
        send("mode", 9.0, Some(0)).unwrap();
        if byte == 0x66 {
            assert!(send("cycleCount", 12.0, Some(9)).is_err());
            assert!(send("running", 1.0, Some(9)).is_err());
            assert!(!writes
                .lock()
                .unwrap()
                .iter()
                .any(|r| matches!(r[3], 0x37 | 0x25)));
        } else {
            send("cycleCount", 12.0, Some(9)).unwrap();
            assert_eq!(manager.snapshot().settings.unwrap().cycle_count, Some(12));
            send("running", 1.0, Some(9)).unwrap();
            assert_eq!(manager.snapshot().telemetry.unwrap().running, Some(true));
            assert!(send("cycleCount", 14.0, Some(9)).is_err());
            send("running", 0.0, Some(9)).unwrap();
            assert_eq!(manager.snapshot().telemetry.unwrap().running, Some(false));
            assert_eq!(
                writes
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|r| r[3] == 0x37)
                    .count(),
                1
            );
        }
    }
}

#[test]
fn usb_sample_rate_changes_cadence_without_sending_control_commands() {
    let (usb, writes, _) = fake(true);
    let manager = connect(usb);
    manager.set_sampling(true).unwrap();
    assert_eq!(manager.snapshot().usb_sample_rate_hz, 1);
    for hz in [1, 2, 5] {
        manager.set_usb_sample_rate(hz).unwrap();
        // Allow the previous blocking read to finish before timing the new rate.
        thread::sleep(Duration::from_millis(120));
        let before = manager.snapshot().sample_count;
        thread::sleep(Duration::from_millis(1200));
        let points = manager.snapshot().sample_count - before;
        assert!(
            points.abs_diff(u64::from(hz) * 12 / 10) <= 2,
            "{hz} Hz produced {points} points"
        );
        assert_eq!(manager.snapshot().usb_sample_rate_hz, hz);
    }
    for invalid in [0, 3, 10, 255] {
        assert!(manager.set_usb_sample_rate(invalid).is_err());
        assert_eq!(manager.snapshot().usb_sample_rate_hz, 5);
    }
    manager.disconnect();
    manager.set_usb_sample_rate(5).unwrap();
    assert_eq!(manager.snapshot().usb_sample_rate_hz, 5);
    assert!(writes
        .lock()
        .unwrap()
        .iter()
        .all(|bytes| matches!(bytes[3], 3 | 5)));
}

#[test]
fn usb_sample_rate_preferences_survive_restart_and_reject_invalid_values() {
    let root =
        std::env::temp_dir().join(format!("atorch_rate_{}_{}", std::process::id(), now_ms()));
    let path = root.join("sampling.json");
    {
        let manager = DeviceManager::with_sampling_preferences(path.clone());
        assert_eq!(manager.snapshot().usb_sample_rate_hz, 1);
        manager.set_usb_sample_rate(5).unwrap();
        assert!(manager.set_usb_sample_rate(3).is_err());
    }
    {
        let manager = DeviceManager::with_sampling_preferences(path.clone());
        assert_eq!(manager.snapshot().usb_sample_rate_hz, 5);
        manager.set_usb_sample_rate(1).unwrap();
    }
    assert_eq!(
        DeviceManager::with_sampling_preferences(path.clone())
            .snapshot()
            .usb_sample_rate_hz,
        1
    );
    std::fs::write(&path, "{\"usbSampleRateHz\":10}").unwrap();
    {
        let manager = DeviceManager::with_sampling_preferences(path.clone());
        assert_eq!(manager.snapshot().usb_sample_rate_hz, 5);
        assert!(manager.set_usb_sample_rate(10).is_err());
        assert_eq!(manager.snapshot().usb_sample_rate_hz, 5);
        manager.set_usb_sample_rate(5).unwrap();
    }
    assert_eq!(
        DeviceManager::with_sampling_preferences(path.clone())
            .snapshot()
            .usb_sample_rate_hz,
        5
    );
    for text in [
        "malformed",
        "{}",
        "{\"usbSampleRateHz\":3}",
        "{\"usbSampleRateHz\":257}",
        "{\"usbSampleRateHz\":1.5}",
    ] {
        std::fs::write(&path, text).unwrap();
        assert_eq!(
            DeviceManager::with_sampling_preferences(path.clone())
                .snapshot()
                .usb_sample_rate_hz,
            1
        );
    }
    let directory = root.join("directory");
    std::fs::create_dir_all(&directory).unwrap();
    let manager = DeviceManager::with_sampling_preferences(directory);
    assert!(manager
        .set_usb_sample_rate(5)
        .unwrap_err()
        .contains("保存失败"));
    assert_eq!(manager.snapshot().usb_sample_rate_hz, 1);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn command_readback_recording_and_shutdown() {
    let (usb, writes, _) = fake(true);
    let manager = connect(usb);
    let path = std::env::temp_dir().join(format!(
        "atorch_test_{}_{}.csv",
        std::process::id(),
        now_ms()
    ));
    manager.record(Some(path.clone())).unwrap();
    manager.set_sampling(true).unwrap();
    manager
        .command(Command {
            kind: "target".into(),
            value: 7.25,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(manager.snapshot().settings.unwrap().target, Some(7.25));
    wait(|| manager.snapshot().sample_count > 0);
    manager.record(None).unwrap();
    assert!(manager.snapshot().recording.is_none());
    let data = std::fs::read_to_string(&path).unwrap();
    assert!(data.starts_with('\u{feff}'));
    assert!(data.contains("FAN_SPEED(RPM)"));
    assert!(data.lines().count() > 1);
    let before = writes.lock().unwrap().len();
    assert!(manager
        .command(Command {
            kind: "target".into(),
            value: f64::NAN,
            ..Default::default()
        })
        .is_err());
    assert!(!writes.lock().unwrap()[before..]
        .iter()
        .any(|r| r[3] == 0x21));
    manager.disconnect();
    assert!(!manager.snapshot().connected);
    assert!(manager
        .command(Command {
            kind: "running".into(),
            value: 0.0,
            ..Default::default()
        })
        .is_err());
    std::fs::remove_file(path).unwrap();
}
#[test]
fn command_without_matching_readback_fails_and_is_not_retried() {
    let (usb, writes, _) = fake(false);
    let manager = connect(usb);
    assert!(manager
        .command(Command {
            kind: "target".into(),
            value: 7.25,
            ..Default::default()
        })
        .unwrap_err()
        .contains("确认"));
    assert_eq!(
        writes
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r[3] == 0x21)
            .count(),
        1
    );
    assert!(manager.snapshot().connected);
    manager.disconnect();
}
#[test]
fn usb_removal_updates_state_and_releases_worker() {
    let (usb, _, removed) = fake(true);
    let manager = connect(usb);
    removed.store(true, Ordering::Relaxed);
    wait(|| !manager.snapshot().connected);
    assert_eq!(manager.snapshot().error.as_deref(), Some("USB removed"));
    manager.disconnect();
}

#[test]
fn mode_switching_reads_all_modes_and_blocks_stale_target_units() {
    let (usb, writes, _) = fake(true);
    let manager = connect(usb);
    for value in 1..=9 {
        manager
            .command(Command {
                kind: "mode".into(),
                value: value as f64,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(manager.snapshot().settings.unwrap().mode, value);
        assert_eq!(manager.snapshot().telemetry.unwrap().running, Some(false));
    }
    assert!(manager
        .command(Command {
            kind: "target".into(),
            value: 1.0,
            expected_mode: Some(0),
            ..Default::default()
        })
        .unwrap_err()
        .contains("模式已变化"));
    assert!(manager
        .command(Command {
            kind: "running".into(),
            value: 1.0,
            ..Default::default()
        })
        .unwrap_err()
        .contains("专用测试"));
    assert!(manager
        .command(Command {
            kind: "target".into(),
            value: 1.0,
            ..Default::default()
        })
        .unwrap_err()
        .contains("普通目标值"));
    let frames = writes.lock().unwrap();
    assert!(!frames.iter().any(|r| r[3] == 0x21 || r[3] == 0x25));
    assert_eq!(
        frames
            .iter()
            .filter(|r| (0x47..=0x50).contains(&r[3]))
            .count(),
        9
    );
}

#[test]
fn successful_ack_cannot_confirm_an_unchanged_mode_and_is_not_retried() {
    let (usb, writes, _) = fake(false);
    let manager = connect(usb);
    assert!(manager
        .command(Command {
            kind: "mode".into(),
            value: 1.0,
            ..Default::default()
        })
        .unwrap_err()
        .contains("确认"));
    assert_eq!(manager.snapshot().settings.unwrap().mode, 0);
    assert_eq!(
        writes
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r[3] == 0x48)
            .count(),
        1
    );
    assert!(manager.snapshot().connected);
}

#[test]
fn running_load_cannot_switch_mode() {
    let (mut usb, writes, _) = fake(true);
    usb.running = true;
    let manager = connect(usb);
    assert!(manager
        .command(Command {
            kind: "mode".into(),
            value: 1.0,
            ..Default::default()
        })
        .unwrap_err()
        .contains("停止负载"));
    assert!(!writes.lock().unwrap().iter().any(|r| r[3] == 0x48));
}

#[test]
fn physical_panel_mode_is_rechecked_before_a_target_write() {
    let (mut usb, writes, _) = fake(true);
    usb.settings[48] = 1;
    let manager = connect(usb);
    // Simulate the frontend / cached snapshot still showing the previous mode.
    manager
        .state
        .lock()
        .unwrap()
        .settings
        .as_mut()
        .unwrap()
        .mode = 0;
    assert!(manager
        .command(Command {
            kind: "target".into(),
            value: 1.0,
            expected_mode: Some(0),
            ..Default::default()
        })
        .unwrap_err()
        .contains("模式已变化"));
    assert_eq!(manager.snapshot().settings.unwrap().mode, 1);
    assert!(!writes.lock().unwrap().iter().any(|r| r[3] == 0x21));
}

#[test]
fn cutoff_and_temperature_writes_confirm_distinct_fields_without_changing_the_other() {
    let (mut usb, writes, _) = fake(true);
    usb.settings[8..12].copy_from_slice(&1.0f32.to_be_bytes());
    usb.settings[20..24].copy_from_slice(&2.5f32.to_be_bytes());
    let manager = connect(usb);
    let initial = manager.snapshot().settings.unwrap();
    assert_eq!(
        (initial.cutoff_voltage, initial.temperature_calibration),
        (2.5, 1.0)
    );
    for (kind, value, expected) in [
        ("cutoffVoltage", 2.75, (2.75, 1.0)),
        ("temperatureCalibration", 1.125, (2.75, 1.125)),
    ] {
        manager
            .command(Command {
                kind: kind.into(),
                value,
                ..Default::default()
            })
            .unwrap();
        let settings = manager.snapshot().settings.unwrap();
        assert_eq!(
            (settings.cutoff_voltage, settings.temperature_calibration),
            expected
        );
    }
    manager.disconnect();
    for opcode in [0x26, 0x29] {
        assert_eq!(
            writes
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r[3] == opcode)
                .count(),
            1
        );
    }
}

#[test]
fn load_controls_enforce_fresh_mode_bounds_and_manual_precision_before_writing() {
    for (mode, target, valid, invalid) in [
        (0, 1.234, 1.237, vec![20.001, 1.2371, -0.001]),
        (1, 5.67, 6.78, vec![2.54, 100.01, 6.789]),
        (2, 12.34, 0.01, vec![0.0, 9999.991, 0.001]),
        (3, 10.1, 10.2, vec![250.2, 10.21, -0.1]),
    ] {
        let (mut usb, writes, _) = fake(true);
        usb.settings[48] = mode;
        usb.settings[4..8].copy_from_slice(&(target as f32).to_be_bytes());
        usb.settings[20..24].copy_from_slice(&2.55f32.to_be_bytes());
        usb.settings[36..40].copy_from_slice(&250.1f32.to_be_bytes());
        let manager = connect(usb);
        for value in invalid {
            assert!(
                manager
                    .command(Command {
                        kind: "target".into(),
                        value,
                        expected_mode: Some(mode),
                        ..Default::default()
                    })
                    .is_err(),
                "mode {mode} accepted {value}"
            );
        }
        assert!(!writes.lock().unwrap().iter().any(|r| r[3] == 0x21));
        manager
            .command(Command {
                kind: "target".into(),
                value: valid,
                expected_mode: Some(mode),
                ..Default::default()
            })
            .unwrap();
        assert!((manager.snapshot().settings.unwrap().target.unwrap() - valid).abs() < 0.00001);
        manager.disconnect();
        assert_eq!(
            writes
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r[3] == 0x21)
                .count(),
            1
        );
    }
}

#[test]
fn device_settings_limits_reject_invalid_values_before_usb_and_confirm_boundaries() {
    for (kind, min, max, increment, opcode) in [
        ("fullVoltage", 0.0, 100.0, 0.01, 0x2a),
        ("cutoffCurrent", 0.0, 20.0, 0.01, 0x2b),
        ("ntcLimit", 0.0, 100.0, 1.0, 0x2e),
        ("mosLimit", 0.0, 100.0, 1.0, 0x2f),
        ("brightness", 0.0, 9.0, 1.0, 0x22),
        ("standbyBrightness", 0.0, 9.0, 1.0, 0x23),
        ("standbySeconds", 10.0, 60.0, 1.0, 0x24),
    ] {
        let (usb, writes, _) = fake(true);
        let manager = connect(usb);
        for value in [min - increment, max + increment, min + increment / 10.0] {
            assert!(
                manager
                    .command(Command {
                        kind: kind.into(),
                        value,
                        ..Default::default()
                    })
                    .is_err(),
                "{kind} accepted {value}"
            );
        }
        assert!(!writes.lock().unwrap().iter().any(|r| r[3] == opcode));
        for value in [min, max] {
            manager
                .command(Command {
                    kind: kind.into(),
                    value,
                    ..Default::default()
                })
                .unwrap();
            assert!(Command {
                kind: kind.into(),
                value,
                ..Default::default()
            }
            .matches(&Report::Settings(manager.snapshot().settings.unwrap())));
        }
        manager.disconnect();
        assert_eq!(
            writes
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r[3] == opcode)
                .count(),
            2
        );
    }
}

#[test]
fn panel_changed_protection_is_rechecked_before_a_target_write() {
    let (mut usb, writes, _) = fake(true);
    usb.settings[32..36].copy_from_slice(&2f32.to_be_bytes());
    let manager = connect(usb);
    manager
        .state
        .lock()
        .unwrap()
        .settings
        .as_mut()
        .unwrap()
        .over_current = 20.0;
    assert!(manager
        .command(Command {
            kind: "target".into(),
            value: 3.0,
            expected_mode: Some(0),
            ..Default::default()
        })
        .unwrap_err()
        .contains("范围"));
    assert_eq!(manager.snapshot().settings.unwrap().over_current, 2.0);
    assert!(!writes.lock().unwrap().iter().any(|r| r[3] == 0x21));
    manager.disconnect();
}

#[test]
fn parameter_ack_without_matching_readback_does_not_report_success_or_retry() {
    let (mut usb, writes, _) = fake(false);
    usb.acknowledge_parameters = true;
    let manager = connect(usb);
    assert!(manager
        .command(Command {
            kind: "target".into(),
            value: 7.25,
            ..Default::default()
        })
        .unwrap_err()
        .contains("确认"));
    assert!((manager.snapshot().settings.unwrap().target.unwrap() - 3.3).abs() < 0.00001);
    manager.disconnect();
    assert_eq!(
        writes
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r[3] == 0x21)
            .count(),
        1
    );
}

#[test]
fn protection_and_cutoff_limits_preserve_active_target_relationships() {
    for (mode, target, kind, invalid, valid, opcode) in [
        (
            0,
            5.123,
            "overCurrent",
            vec![5.122, 20.001, 10.1234],
            5.123,
            0x2c,
        ),
        (
            3,
            100.1,
            "overPower",
            vec![100.0, 400.1, 200.01],
            100.1,
            0x2d,
        ),
        (
            1,
            5.67,
            "cutoffVoltage",
            vec![5.68, 100.01, 2.551],
            2.55,
            0x29,
        ),
    ] {
        let (mut usb, writes, _) = fake(true);
        usb.settings[48] = mode;
        usb.settings[4..8].copy_from_slice(&(target as f32).to_be_bytes());
        let manager = connect(usb);
        for value in invalid {
            assert!(manager
                .command(Command {
                    kind: kind.into(),
                    value,
                    ..Default::default()
                })
                .is_err());
        }
        assert!(!writes.lock().unwrap().iter().any(|r| r[3] == opcode));
        manager
            .command(Command {
                kind: kind.into(),
                value: valid,
                ..Default::default()
            })
            .unwrap();
        manager.disconnect();
        assert_eq!(
            writes
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r[3] == opcode)
                .count(),
            1
        );
    }
}

#[test]
fn duration_writes_validate_combined_minutes_and_use_existing_two_part_protocol() {
    let (usb, writes, _) = fake(true);
    let manager = connect(usb);
    for (kind, value) in [
        ("limitHours", 0.0),
        ("limitHours", 100.0),
        ("limitHours", 1.5),
        ("limitMinutes", 60.0),
        ("limitMinutes", 1.5),
    ] {
        assert!(manager
            .command(Command {
                kind: kind.into(),
                value,
                ..Default::default()
            })
            .is_err());
    }
    assert!(!writes.lock().unwrap().iter().any(|r| r[3] == 0x31));
    for (kind, value, h, m) in [
        ("limitMinutes", 1.0, 2, 1),
        ("limitHours", 0.0, 0, 1),
        ("limitHours", 99.0, 99, 1),
        ("limitMinutes", 59.0, 99, 59),
    ] {
        manager
            .command(Command {
                kind: kind.into(),
                value,
                ..Default::default()
            })
            .unwrap();
        let settings = manager.snapshot().settings.unwrap();
        assert_eq!((settings.limit_hours, settings.limit_minutes), (h, m));
    }
    manager.disconnect();
    let frames = writes.lock().unwrap();
    let payloads: Vec<_> = frames
        .iter()
        .filter(|r| r[3] == 0x31)
        .map(|r| (r[4], r[7]))
        .collect();
    assert_eq!(payloads, vec![(1, 2), (0, 1), (99, 1), (59, 2)]);
}

fn cyclic_usb(readback: bool) -> (Box<FakeUsb>, CapturedWrites) {
    let (mut usb, writes, _) = fake(readback);
    usb.settings[48] = 7;
    usb.settings[20..24].copy_from_slice(&3.0f32.to_be_bytes());
    usb.settings[24..28].copy_from_slice(&4.2f32.to_be_bytes());
    usb.settings[28..32].copy_from_slice(&0.05f32.to_be_bytes());
    usb.status = 8;
    usb.stage = 32;
    (usb, writes)
}

#[test]
fn stage_commands_recheck_context_require_device_transition_and_record_stop() {
    let (usb, writes) = cyclic_usb(true);
    let manager = connect(usb);
    wait(|| manager.snapshot().special_test.is_some());
    let mut c = Command {
        kind: "stage".into(),
        value: 2.0,
        expected_mode: Some(7),
        expected_prompt: Some(atorch_protocol::special::PromptContext {
            status: 8,
            code: 31,
        }),
    };
    assert!(manager.command(c.clone()).unwrap_err().contains("已变化"));
    assert!(!writes.lock().unwrap().iter().any(|r| r[3] == 0x35));
    c.expected_prompt.as_mut().unwrap().code = 32;
    manager.command(c).unwrap();
    assert_eq!(
        manager.snapshot().telemetry.as_ref().unwrap().running,
        Some(true)
    );
    assert!(manager
        .snapshot()
        .special_test
        .as_ref()
        .unwrap()
        .reading
        .prompt
        .is_none());
    manager
        .command(Command {
            kind: "running".into(),
            value: 0.0,
            ..Default::default()
        })
        .unwrap();
    wait(|| manager.snapshot().special_results.len() == 1);
    assert!(manager.snapshot().special_results[0].observed_start);
    assert_eq!(
        writes
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r[3] == 0x35)
            .count(),
        1
    );
}

#[test]
fn stage_ack_alone_never_succeeds_or_retries_the_destructive_action() {
    let (usb, writes) = cyclic_usb(false);
    let manager = connect(usb);
    let c = Command {
        kind: "stage".into(),
        value: 3.0,
        expected_mode: Some(7),
        expected_prompt: Some(atorch_protocol::special::PromptContext {
            status: 8,
            code: 32,
        }),
    };
    assert!(manager.command(c).unwrap_err().contains("确认"));
    assert_eq!(
        writes
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r[3] == 0x35)
            .count(),
        1
    );
    assert_eq!(
        manager.snapshot().telemetry.as_ref().unwrap().stage_code,
        Some(32)
    );
    assert!(manager.snapshot().special_results.is_empty());
}

#[test]
fn special_start_uses_vendor_run_but_cycles_cannot_bypass_prompt_or_parameters() {
    let (mut usb, writes, _) = fake(true);
    usb.settings[48] = 4;
    let manager = connect(usb);
    manager
        .command(Command {
            kind: "running".into(),
            value: 1.0,
            expected_mode: Some(4),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(manager.snapshot().telemetry.unwrap().running, Some(true));
    manager
        .command(Command {
            kind: "running".into(),
            value: 0.0,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        writes
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r[3] == 0x25)
            .count(),
        2
    );
    manager.disconnect();
    let (usb, writes) = cyclic_usb(true);
    let manager = connect(usb);
    assert!(manager
        .command(Command {
            kind: "running".into(),
            value: 1.0,
            expected_mode: Some(7),
            ..Default::default()
        })
        .unwrap_err()
        .contains("阶段选择"));
    assert!(!writes.lock().unwrap().iter().any(|r| r[3] == 0x25));
}

#[test]
fn sampling_pause_resume_and_clear_apply_to_usb_and_ble_buffers_and_csv() {
    for bluetooth in [false, true] {
        let (transport, writes): (Box<dyn Transport>, CapturedWrites) = if bluetooth {
            let writes = Arc::new(Mutex::new(Vec::new()));
            (
                Box::new(FakeBle {
                    second: false,
                    removed: Arc::new(AtomicBool::new(false)),
                    writes: writes.clone(),
                }),
                writes,
            )
        } else {
            let (usb, writes, _) = fake(true);
            (usb, writes)
        };
        let manager = DeviceManager::default();
        manager
            .connect(
                DeviceInfo {
                    path: "sampling-fixture".into(),
                    name: "test".into(),
                    serial: "".into(),
                    vendor_id: 0,
                    product_id: 0,
                    transport: transport.kind(),
                    rssi: None,
                },
                transport,
                std::env::temp_dir(),
            )
            .unwrap();
        wait(|| manager.snapshot().telemetry.is_some());
        manager.set_sampling(true).unwrap();
        wait(|| manager.snapshot().sample_count > 0);
        assert_eq!(manager.samples()[0].elapsed_ms, 0);
        let path = std::env::temp_dir().join(format!(
            "atorch_sampling_{}_{}_{}.csv",
            std::process::id(),
            bluetooth,
            now_ms()
        ));
        manager.record(Some(path.clone())).unwrap();
        let start = manager.snapshot().sample_count;
        wait(|| manager.snapshot().sample_count > start);
        manager.set_sampling(false).unwrap();
        let paused = manager.snapshot();
        let rows = csv(&manager.samples());
        let saved = std::fs::read_to_string(&path).unwrap();
        // Let fresh transport reports arrive; pausing collection must affect
        // the native buffer and recorder rather than only freezing the UI.
        wait(|| {
            manager.snapshot().telemetry.as_ref().unwrap().timestamp
                > paused.telemetry.as_ref().unwrap().timestamp
        });
        assert_eq!(manager.snapshot().sample_count, paused.sample_count);
        assert_eq!(
            manager.snapshot().sampling_elapsed_ms,
            paused.sampling_elapsed_ms
        );
        assert_eq!(csv(&manager.samples()), rows);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), saved);
        let resume_at = Instant::now();
        manager.set_sampling(true).unwrap();
        wait(|| manager.snapshot().sample_count > paused.sample_count);
        let after_resume = manager.samples().last().unwrap().elapsed_ms;
        assert!(after_resume >= paused.sampling_elapsed_ms);
        assert!(
            after_resume - paused.sampling_elapsed_ms <= resume_at.elapsed().as_millis() as u64 + 5
        );
        manager.set_sampling(false).unwrap();
        manager.clear_samples().unwrap();
        assert!(manager.samples().is_empty());
        assert_eq!(manager.snapshot().sample_count, 0);
        assert!(manager.snapshot().sampling_paused);
        assert_eq!(manager.snapshot().sampling_elapsed_ms, 0);
        let cleared_at = manager.snapshot().last_report_at;
        wait(|| manager.snapshot().last_report_at > cleared_at);
        assert!(manager.samples().is_empty());
        assert_eq!(manager.snapshot().sampling_elapsed_ms, 0);
        manager.set_sampling(true).unwrap();
        wait(|| manager.snapshot().sample_count > 0);
        assert!(!manager.snapshot().sampling_paused);
        assert_eq!(manager.samples()[0].elapsed_ms, 0);
        assert!(manager
            .samples()
            .iter()
            .all(|row| row.timestamp > paused.telemetry.as_ref().unwrap().timestamp));
        manager.disconnect();
        let ended_at = manager.snapshot().sampling_elapsed_ms;
        thread::sleep(Duration::from_millis(30));
        assert_eq!(manager.snapshot().sampling_elapsed_ms, ended_at);
        assert!(manager.set_sampling(true).is_err());
        manager.clear_samples().unwrap();
        assert_eq!(manager.snapshot().sample_count, 0);
        assert!(manager.samples().is_empty());
        assert!(writes
            .lock()
            .unwrap()
            .iter()
            .all(|report| !bluetooth && matches!(report[3], 3 | 5)));
        std::fs::remove_file(path).unwrap();
    }
}

struct FakeBle {
    second: bool,
    removed: Arc<AtomicBool>,
    writes: Arc<Mutex<Vec<Vec<u8>>>>,
}
impl Transport for FakeBle {
    fn kind(&self) -> TransportKind {
        TransportKind::Bluetooth
    }
    fn write(&mut self, data: &[u8]) -> Result<(), String> {
        atorch_protocol::ble::validate_command(data)?;
        self.writes.lock().unwrap().push(data.to_vec());
        Ok(())
    }
    fn read(&mut self, buffer: &mut [u8], _: i32) -> Result<usize, String> {
        if self.removed.load(Ordering::Relaxed) {
            return Err("BLE disconnected".into());
        }
        let frame = [
            0xff, 0x55, 1, 2, 0, 0, 0, 0, 0, 0, 0, 2, 0x96, 0, 0, 0, 0, 0, 0, 0x64, 0, 0, 0, 0, 0,
            0x1a, 0, 1, 0, 0x1c, 0x3c, 0, 0, 0, 0, 0x23,
        ];
        let bytes = if self.second {
            &frame[20..]
        } else {
            &frame[..20]
        };
        self.second = !self.second;
        buffer[..bytes.len()].copy_from_slice(bytes);
        thread::sleep(Duration::from_millis(10));
        Ok(bytes.len())
    }
}
#[test]
fn ble_notifications_record_gaps_and_never_send_usb_commands() {
    let writes = Arc::new(Mutex::new(Vec::new()));
    let removed = Arc::new(AtomicBool::new(false));
    let manager = DeviceManager::default();
    manager
        .connect(
            DeviceInfo {
                path: "ble://00:00:00:17:BB:84".into(),
                name: "BW150_BLE".into(),
                serial: "".into(),
                vendor_id: 0,
                product_id: 0,
                transport: TransportKind::Bluetooth,
                rssi: Some(-50),
            },
            Box::new(FakeBle {
                second: false,
                removed: removed.clone(),
                writes: writes.clone(),
            }),
            std::env::temp_dir(),
        )
        .unwrap();
    wait(|| manager.snapshot().sample_count > 1);
    let s = manager.snapshot();
    assert!(s.settings.is_none());
    assert!(s.telemetry.as_ref().unwrap().running.is_none());
    assert_eq!(s.telemetry.as_ref().unwrap().capacity, 6620.0);
    assert!(manager
        .command(Command {
            kind: "running".into(),
            value: 1.0,
            ..Default::default()
        })
        .unwrap_err()
        .contains("不支持 USB"));
    assert!(manager
        .command(Command {
            kind: "mode".into(),
            value: 1.0,
            ..Default::default()
        })
        .unwrap_err()
        .contains("不支持 USB"));
    let path = std::env::temp_dir().join(format!(
        "atorch_ble_{}_{}.csv",
        std::process::id(),
        now_ms()
    ));
    manager.record(Some(path.clone())).unwrap();
    let start = manager.snapshot().sample_count;
    wait(|| manager.snapshot().sample_count > start + 2);
    manager.record(None).unwrap();
    let csv = std::fs::read_to_string(&path).unwrap();
    for row in csv.lines().skip(1) {
        let cells: Vec<_> = row.split(',').collect();
        assert_eq!(cells.len(), 11);
        for index in [7, 8, 10] {
            assert_eq!(cells[index], "");
        }
        assert_eq!(cells[4], "0.000");
        assert_eq!(cells[5], "0.000");
        assert_eq!(cells[6], "6620.000");
        assert_eq!(cells[9], "26.000");
    }
    removed.store(true, Ordering::Relaxed);
    wait(|| !manager.snapshot().connected);
    assert_eq!(
        manager.snapshot().error.as_deref(),
        Some("BLE disconnected")
    );
    manager.disconnect();
    assert!(writes.lock().unwrap().is_empty());
    std::fs::remove_file(path).unwrap();
}

#[test]
fn ble_estimates_reach_snapshot_history_and_csv_but_usb_keeps_device_values() {
    let state = Arc::new(Mutex::new(Snapshot {
        device: Some(DeviceInfo {
            path: "ble://derived-test".into(),
            name: "test".into(),
            serial: "".into(),
            vendor_id: 0,
            product_id: 0,
            transport: TransportKind::Bluetooth,
            rssi: None,
        }),
        ..Default::default()
    }));
    let samples = Arc::new(Mutex::new(VecDeque::new()));
    let mut recorder = recorder::Recorder::new(std::env::temp_dir());
    recorder.manual(None, &mut state.lock().unwrap()).unwrap();
    for timestamp in [1000, 2000, 3000] {
        accept_report(
            Report::Telemetry(Telemetry {
                timestamp,
                voltage: 12.0,
                current: 0.3,
                power: 3.6,
                ..Default::default()
            }),
            &state,
            &samples,
            &mut recorder,
        )
        .unwrap();
    }
    let latest = state.lock().unwrap().telemetry.clone().unwrap();
    assert_eq!(latest.resistance, Some(40.0));
    assert!((latest.energy.unwrap() - 0.002).abs() < 1e-12);
    assert_eq!(
        samples.lock().unwrap().back().unwrap().energy,
        latest.energy
    );
    assert!(
        csv(&samples.lock().unwrap().iter().cloned().collect::<Vec<_>>()).contains("40.000,0.002")
    );
    // A transport switch must never replace actual USB counters with estimates.
    state.lock().unwrap().device.as_mut().unwrap().transport = TransportKind::Usb;
    accept_report(
        Report::Telemetry(Telemetry {
            timestamp: 4000,
            voltage: 12.0,
            current: 0.3,
            power: 3.6,
            resistance: Some(39.991),
            energy: Some(129.664),
            ..Default::default()
        }),
        &state,
        &samples,
        &mut recorder,
    )
    .unwrap();
    let latest = state.lock().unwrap().telemetry.clone().unwrap();
    assert_eq!(latest.resistance, Some(39.991));
    assert_eq!(latest.energy, Some(129.664));
}

#[test]
fn ble_panel_commands_are_single_writes_with_no_fake_execution_ack() {
    let writes = Arc::new(Mutex::new(Vec::new()));
    let removed = Arc::new(AtomicBool::new(false));
    let manager = DeviceManager::default();
    manager
        .connect(
            DeviceInfo {
                path: "ble://test".into(),
                name: "BW150_BLE".into(),
                serial: String::new(),
                vendor_id: 0,
                product_id: 0,
                transport: TransportKind::Bluetooth,
                rssi: None,
            },
            Box::new(FakeBle {
                second: false,
                removed: removed.clone(),
                writes: writes.clone(),
            }),
            std::env::temp_dir(),
        )
        .unwrap();
    wait(|| manager.snapshot().sample_count > 0);
    let reply = manager
        .ble_command(atorch_protocol::ble::Command::KeyPlus)
        .unwrap();
    assert!(!reply.device_confirmed);
    assert!(reply.message.contains("未提供执行确认"));
    assert_eq!(
        *writes.lock().unwrap(),
        vec![atorch_protocol::ble::Command::KeyPlus.encode().to_vec()]
    );
    assert!(manager
        .ble_command(atorch_protocol::ble::Command::KeyPlus)
        .unwrap_err()
        .contains("过于频繁"));
    thread::sleep(Duration::from_millis(320));
    manager
        .ble_command(atorch_protocol::ble::Command::KeyMinus)
        .unwrap();
    assert_eq!(writes.lock().unwrap().len(), 2);
    assert!(manager.snapshot().settings.is_none());
    assert_eq!(manager.snapshot().telemetry.unwrap().running, None);
    removed.store(true, Ordering::Relaxed);
    wait(|| !manager.snapshot().connected);
    assert!(manager
        .ble_command(atorch_protocol::ble::Command::KeyOk)
        .is_err());
    assert_eq!(writes.lock().unwrap().len(), 2);
    manager.disconnect();
}

#[test]
fn ble_panel_commands_cannot_be_sent_on_a_usb_connection() {
    let (usb, writes, _) = fake(true);
    let manager = connect(usb);
    assert!(manager
        .ble_command(atorch_protocol::ble::Command::ClearCapacity)
        .unwrap_err()
        .contains("蓝牙"));
    assert!(writes.lock().unwrap().iter().all(|bytes| bytes[0] == 0x55));
    manager.disconnect();
}

#[test]
fn automatic_recording_follows_load_and_sampling_and_resumes_the_same_file() {
    let directory =
        std::env::temp_dir().join(format!("atorch_auto_{}_{}", std::process::id(), now_ms()));
    let (usb, _, _) = fake(true);
    let manager = DeviceManager::default();
    manager.set_auto_record_on_load(true).unwrap();
    manager
        .connect(
            DeviceInfo {
                path: "auto-recording".into(),
                name: "BW150".into(),
                serial: "test".into(),
                vendor_id: 0,
                product_id: 0,
                transport: TransportKind::Usb,
                rssi: None,
            },
            usb,
            directory.clone(),
        )
        .unwrap();
    wait(|| manager.snapshot().telemetry.is_some());
    manager.set_usb_sample_rate(5).unwrap();
    assert!(manager.snapshot().recording.is_none());
    let running = |value| Command {
        kind: "running".into(),
        value,
        ..Default::default()
    };
    manager.command(running(1.0)).unwrap();
    wait(|| manager.snapshot().recording.is_some());
    let path = manager.snapshot().recording.unwrap();
    let before_pause = manager.snapshot().sample_count;
    wait(|| manager.snapshot().sample_count > before_pause);
    manager.command(running(0.0)).unwrap();
    assert!(manager.snapshot().recording_paused);
    assert!(manager.snapshot().sampling_paused);
    let paused = std::fs::read_to_string(&path).unwrap();
    let count = manager.snapshot().sample_count;
    let report = manager.snapshot().last_report_at;
    wait(|| manager.snapshot().last_report_at > report);
    assert_eq!(manager.snapshot().sample_count, count);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), paused);
    manager.command(running(1.0)).unwrap();
    assert_eq!(manager.snapshot().recording.as_deref(), Some(path.as_str()));
    assert!(!manager.snapshot().recording_paused);
    wait(|| std::fs::read_to_string(&path).unwrap().len() > paused.len());
    manager.set_sampling(false).unwrap();
    let paused = std::fs::read_to_string(&path).unwrap();
    let last = manager.snapshot().last_report_at;
    wait(|| manager.snapshot().last_report_at > last);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), paused);
    assert!(manager.snapshot().recording_paused);
    manager.set_sampling(true).unwrap();
    wait(|| std::fs::read_to_string(&path).unwrap().len() > paused.len());
    manager.set_sampling(false).unwrap();
    let completed = std::fs::read_to_string(&path).unwrap();
    manager.clear_samples().unwrap();
    assert!(manager.snapshot().recording.is_none());
    assert!(manager.samples().is_empty());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), completed);
    manager.set_sampling(true).unwrap();
    wait(|| manager.snapshot().recording.is_some());
    let next_path = manager.snapshot().recording.unwrap();
    assert_ne!(next_path, path);
    manager.disconnect();
    let data = std::fs::read_to_string(&path).unwrap();
    assert!(data
        .lines()
        .next()
        .unwrap()
        .ends_with(",ELAPSED_MS,SEGMENT_ID"));
    assert_eq!(
        data.lines().skip(1).filter(|r| !r.is_empty()).count(),
        data.lines()
            .skip(1)
            .filter(|r| r.split(',').count() == 13)
            .count()
    );
    assert!(!recordings::list(&directory, None).unwrap()[0].active);
    // Every persisted time delta excludes the interval during load/sampling pause.
    let elapsed: Vec<u64> = data
        .lines()
        .skip(1)
        .map(|r| r.split(',').nth(11).unwrap().parse().unwrap())
        .collect();
    assert_eq!(elapsed[0], 0);
    assert!(elapsed.windows(2).all(|p| p[1] >= p[0]));
    let segments: Vec<u64> = data
        .lines()
        .skip(1)
        .map(|r| r.split(',').nth(12).unwrap().parse().unwrap())
        .collect();
    assert!(segments.last().unwrap() > &segments[0]);
    std::fs::remove_file(&path).unwrap();
    std::fs::remove_file(next_path).unwrap();
    std::fs::remove_dir(directory).unwrap();
}

#[test]
fn usb_panel_state_edges_sync_sampling_once_and_preserve_manual_overrides() {
    for initially_running in [false, true] {
        let directory = std::env::temp_dir().join(format!(
            "atorch_panel_edges_{}_{}_{}",
            std::process::id(),
            now_ms(),
            initially_running
        ));
        let panel = Arc::new(AtomicBool::new(initially_running));
        let (mut usb, writes, _) = fake(true);
        usb.panel_running = Some(panel.clone());
        let manager = DeviceManager::default();
        manager.set_auto_record_on_load(true).unwrap();
        manager.set_usb_sample_rate(5).unwrap();
        manager
            .connect(
                DeviceInfo {
                    path: "physical-panel".into(),
                    name: "BW150".into(),
                    serial: "fixture".into(),
                    vendor_id: 0,
                    product_id: 0,
                    transport: TransportKind::Usb,
                    rssi: None,
                },
                usb,
                directory.clone(),
            )
            .unwrap();
        wait(|| manager.snapshot().telemetry.is_some());
        assert_eq!(manager.snapshot().sampling_paused, !initially_running);
        assert_eq!(manager.snapshot().recording.is_some(), initially_running);

        // Manual pause masks start. Continuing after the initial automatic stop
        // stays active until the panel leaves and re-enters the stop state.
        manager.set_sampling(!initially_running).unwrap();
        let overridden_count = manager.snapshot().sample_count;
        for _ in 0..3 {
            let report = manager.snapshot().telemetry.unwrap().timestamp;
            wait(|| manager.snapshot().telemetry.unwrap().timestamp > report);
            assert_eq!(manager.snapshot().sampling_paused, initially_running);
        }
        if initially_running {
            assert_eq!(manager.snapshot().sample_count, overridden_count);
            assert!(manager.snapshot().recording_paused);
        } else {
            assert!(manager.snapshot().sample_count > overridden_count);
            assert!(manager.snapshot().recording.is_some());
        }

        // A physical stop/start transition restores automatic behavior.
        panel.store(!initially_running, Ordering::Relaxed);
        wait(|| manager.snapshot().telemetry.unwrap().running == Some(!initially_running));
        assert_eq!(manager.snapshot().sampling_paused, initially_running);
        panel.store(initially_running, Ordering::Relaxed);
        wait(|| manager.snapshot().telemetry.unwrap().running == Some(initially_running));
        assert_eq!(manager.snapshot().sampling_paused, !initially_running);
        assert_eq!(manager.snapshot().recording_paused, !initially_running);
        let samples = manager.samples();
        if initially_running {
            assert!(samples.last().unwrap().segment_id > samples[0].segment_id);
        }
        manager.disconnect();
        assert!(writes.lock().unwrap().iter().all(|r| matches!(r[3], 3 | 5)));
        for file in recordings::list(&directory, None).unwrap() {
            std::fs::remove_file(directory.join(file.name)).unwrap();
        }
        std::fs::remove_dir(directory).unwrap();
    }
}

#[test]
fn automatic_load_recording_is_off_by_default_and_preferences_are_independent() {
    let root = std::env::temp_dir().join(format!(
        "atorch_record_preferences_{}_{}",
        std::process::id(),
        now_ms()
    ));
    let path = root.join("sampling.json");
    let manager = DeviceManager::with_sampling_preferences(path.clone());
    assert!(!manager.snapshot().auto_record_on_load);
    manager.set_auto_record_on_load(true).unwrap();
    manager.set_usb_sample_rate(5).unwrap();
    let restarted = DeviceManager::with_sampling_preferences(path.clone());
    assert!(restarted.snapshot().auto_record_on_load);
    assert_eq!(restarted.snapshot().usb_sample_rate_hz, 5);
    restarted.set_auto_record_on_load(false).unwrap();
    let restarted = DeviceManager::with_sampling_preferences(path.clone());
    assert!(!restarted.snapshot().auto_record_on_load);
    assert_eq!(restarted.snapshot().usb_sample_rate_hz, 5);
    // Existing installations have only the sampling rate: the new setting is off.
    std::fs::write(&path, r#"{"usbSampleRateHz": 10}"#).unwrap();
    let migrated = DeviceManager::with_sampling_preferences(path.clone());
    assert!(!migrated.snapshot().auto_record_on_load);
    assert_eq!(migrated.snapshot().usb_sample_rate_hz, 5);
    std::fs::write(&path, r#"{"usbSampleRateHz": 3, "autoRecordOnLoad": true}"#).unwrap();
    let independent = DeviceManager::with_sampling_preferences(path);
    assert!(independent.snapshot().auto_record_on_load);
    assert_eq!(independent.snapshot().usb_sample_rate_hz, 1);
    let directory = root.join("directory");
    std::fs::create_dir_all(&directory).unwrap();
    let failed = DeviceManager::with_sampling_preferences(directory);
    assert!(failed
        .set_auto_record_on_load(true)
        .unwrap_err()
        .contains("保存失败"));
    assert!(!failed.snapshot().auto_record_on_load);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn load_recording_switch_controls_usb_edges_without_sending_device_commands() {
    let root = std::env::temp_dir().join(format!(
        "atorch_record_toggle_{}_{}",
        std::process::id(),
        now_ms()
    ));
    let panel = Arc::new(AtomicBool::new(false));
    let (mut usb, writes, _) = fake(true);
    usb.panel_running = Some(panel.clone());
    let manager = DeviceManager::default();
    manager.set_usb_sample_rate(5).unwrap();
    manager
        .connect(
            DeviceInfo {
                path: "record-toggle".into(),
                name: "BW150".into(),
                serial: "fixture".into(),
                vendor_id: 0,
                product_id: 0,
                transport: TransportKind::Usb,
                rssi: None,
            },
            usb,
            root.clone(),
        )
        .unwrap();
    wait(|| manager.snapshot().sample_count >= 2);
    assert!(!manager.snapshot().auto_record_on_load);
    assert!(!manager.snapshot().sampling_paused);
    assert!(manager.snapshot().recording.is_some());
    let path = manager.snapshot().recording.unwrap();
    manager.set_sampling(false).unwrap();
    let paused_count = manager.snapshot().sample_count;
    panel.store(true, Ordering::Relaxed);
    wait(|| manager.snapshot().telemetry.unwrap().running == Some(true));
    assert!(manager.snapshot().sampling_paused);
    assert_eq!(manager.snapshot().sample_count, paused_count);
    // Enabling applies the current running state once, without waiting for an edge.
    manager.set_auto_record_on_load(true).unwrap();
    assert!(!manager.snapshot().sampling_paused);
    wait(|| manager.snapshot().sample_count > paused_count);
    panel.store(false, Ordering::Relaxed);
    wait(|| manager.snapshot().telemetry.unwrap().running == Some(false));
    assert!(manager.snapshot().sampling_paused);
    assert!(manager.snapshot().recording_paused);
    manager.set_auto_record_on_load(false).unwrap();
    let paused_count = manager.snapshot().sample_count;
    panel.store(true, Ordering::Relaxed);
    wait(|| manager.snapshot().telemetry.unwrap().running == Some(true));
    assert!(manager.snapshot().sampling_paused);
    assert_eq!(manager.snapshot().sample_count, paused_count);
    manager.set_sampling(true).unwrap();
    wait(|| manager.snapshot().sample_count > paused_count);
    assert_eq!(manager.snapshot().recording.as_deref(), Some(path.as_str()));
    manager.disconnect();
    assert!(writes.lock().unwrap().iter().all(|r| matches!(r[3], 3 | 5)));
    for file in recordings::list(&root, None).unwrap() {
        std::fs::remove_file(root.join(file.name)).unwrap();
    }
    std::fs::remove_dir(root).unwrap();
}

#[test]
fn automatic_recording_failure_keeps_the_load_connected_and_sampling() {
    let directory = std::env::temp_dir().join(format!(
        "atorch_auto_failure_{}_{}",
        std::process::id(),
        now_ms()
    ));
    std::fs::write(&directory, "file blocking the record directory").unwrap();
    let (mut usb, _, _) = fake(true);
    usb.running = true;
    let manager = DeviceManager::default();
    manager
        .connect(
            DeviceInfo {
                path: "auto-recording-error".into(),
                name: "BW150".into(),
                serial: "test".into(),
                vendor_id: 0,
                product_id: 0,
                transport: TransportKind::Usb,
                rssi: None,
            },
            usb,
            directory.clone(),
        )
        .unwrap();
    wait(|| manager.snapshot().recording_error.is_some());
    assert!(manager.snapshot().connected);
    assert!(manager.snapshot().recording.is_none());
    assert!(manager.snapshot().error.is_none());
    let count = manager.snapshot().sample_count;
    wait(|| manager.snapshot().sample_count > count);
    manager.disconnect();
    std::fs::remove_file(directory).unwrap();
}
