use atorch_protocol::Telemetry;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Off,
    Device,
    Threshold,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DeviceRule {
    pub enabled: bool,
    pub delay_seconds: f64,
}

impl Default for DeviceRule {
    fn default() -> Self {
        Self {
            enabled: true,
            delay_seconds: 0.0,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Parameter {
    #[default]
    Voltage,
    Current,
    Power,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Comparison {
    Less,
    #[default]
    Greater,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ThresholdRule {
    pub enabled: bool,
    pub parameter: Parameter,
    pub comparison: Comparison,
    pub value: f64,
    pub hold_seconds: f64,
}

impl Default for ThresholdRule {
    fn default() -> Self {
        Self {
            enabled: false,
            parameter: Parameter::Voltage,
            comparison: Comparison::Greater,
            value: 0.0,
            hold_seconds: 0.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub mode: Mode,
    pub start_on_load: DeviceRule,
    pub stop_on_load: DeviceRule,
    pub start_threshold: ThresholdRule,
    pub stop_threshold: ThresholdRule,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            mode: Mode::Off,
            start_on_load: DeviceRule::default(),
            stop_on_load: DeviceRule::default(),
            start_threshold: ThresholdRule::default(),
            stop_threshold: ThresholdRule {
                comparison: Comparison::Less,
                ..ThresholdRule::default()
            },
        }
    }
}

impl Settings {
    pub fn waits_for_start(&self) -> bool {
        match self.mode {
            Mode::Off => false,
            Mode::Device => self.start_on_load.enabled,
            Mode::Threshold => self.start_threshold.enabled,
        }
    }
    pub fn from_legacy(enabled: bool) -> Self {
        Self {
            mode: if enabled { Mode::Device } else { Mode::Off },
            ..Self::default()
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        for seconds in [
            self.start_on_load.delay_seconds,
            self.stop_on_load.delay_seconds,
            self.start_threshold.hold_seconds,
            self.stop_threshold.hold_seconds,
        ] {
            if Duration::try_from_secs_f64(seconds).is_err() {
                return Err("记录延迟和保持时间必须为非负的有效秒数".into());
            }
            if ((seconds * 10.0).round() - seconds * 10.0).abs() > 1e-7 {
                return Err("记录时间最多保留一位小数".into());
            }
        }
        if !self.start_threshold.value.is_finite() || !self.stop_threshold.value.is_finite() {
            return Err("记录阈值必须为有效数值".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default)]
struct Condition {
    since: Option<Instant>,
    consumed: bool,
}

impl Condition {
    fn observe(&mut self, active: bool, seconds: f64, now: Instant) -> bool {
        if !active {
            *self = Self::default();
            return false;
        }
        let since = *self.since.get_or_insert(now);
        if !self.consumed && now.saturating_duration_since(since).as_secs_f64() >= seconds {
            self.consumed = true;
            return true;
        }
        false
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct Runtime {
    start: Condition,
    stop: Condition,
}

impl Runtime {
    pub fn manual_sampling(&mut self, enabled: bool) {
        if !enabled {
            self.start.consumed = true;
        }
    }
    /// Evaluate only fresh telemetry, even while collection is paused. Each
    /// condition fires once and rearms after becoming false. Manual resume keeps
    /// a consumed stop consumed, while an unfinished stop hold can still finish.
    pub fn observe(
        &mut self,
        settings: &Settings,
        telemetry: &Telemetry,
        usb: bool,
        now: Instant,
    ) -> Option<bool> {
        let (start, stop, start_time, stop_time) = match settings.mode {
            Mode::Off => (false, false, 0.0, 0.0),
            Mode::Device => (
                usb && settings.start_on_load.enabled && telemetry.running == Some(true),
                usb && settings.stop_on_load.enabled && telemetry.running == Some(false),
                settings.start_on_load.delay_seconds,
                settings.stop_on_load.delay_seconds,
            ),
            Mode::Threshold => (
                matches_threshold(&settings.start_threshold, telemetry),
                matches_threshold(&settings.stop_threshold, telemetry),
                settings.start_threshold.hold_seconds,
                settings.stop_threshold.hold_seconds,
            ),
        };
        let start = self.start.observe(start, start_time, now);
        let stop = self.stop.observe(stop, stop_time, now);
        // Overlapping thresholds cannot start/stop repeatedly on the same report.
        if stop {
            Some(false)
        } else if start {
            Some(true)
        } else {
            None
        }
    }
}

fn matches_threshold(rule: &ThresholdRule, telemetry: &Telemetry) -> bool {
    if !rule.enabled {
        return false;
    }
    let value = match rule.parameter {
        Parameter::Voltage => telemetry.voltage,
        Parameter::Current => telemetry.current,
        Parameter::Power => telemetry.power,
    };
    value.is_finite()
        && match rule.comparison {
            Comparison::Less => value < rule.value,
            Comparison::Greater => value > rule.value,
        }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn telemetry() -> Telemetry {
        Telemetry {
            timestamp: 1,
            voltage: 12.0,
            current: 0.5,
            power: 6.0,
            energy: None,
            capacity: 0.0,
            resistance: None,
            cpu_temperature: None,
            mos_temperature: None,
            ntc_temperature: None,
            fan_speed: None,
            running: Some(false),
            status: 0,
            stage_code: None,
        }
    }

    #[test]
    fn device_delays_are_independent_cancel_on_reversal_and_fire_only_once() {
        let mut settings = Settings::from_legacy(true);
        settings.start_on_load.delay_seconds = 2.0;
        settings.stop_on_load.delay_seconds = 1.0;
        let mut runtime = Runtime::default();
        let start = Instant::now();
        let mut t = telemetry();
        t.running = Some(true);
        assert_eq!(runtime.observe(&settings, &t, true, start), None);
        assert_eq!(
            runtime.observe(&settings, &t, true, start + Duration::from_millis(1999)),
            None
        );
        assert_eq!(
            runtime.observe(&settings, &t, true, start + Duration::from_secs(2)),
            Some(true)
        );
        assert_eq!(
            runtime.observe(&settings, &t, true, start + Duration::from_secs(20)),
            None
        );
        t.running = Some(false);
        assert_eq!(
            runtime.observe(&settings, &t, true, start + Duration::from_secs(21)),
            None
        );
        t.running = Some(true);
        assert_eq!(
            runtime.observe(&settings, &t, true, start + Duration::from_millis(21500)),
            None
        );
        t.running = Some(false);
        assert_eq!(
            runtime.observe(&settings, &t, true, start + Duration::from_secs(22)),
            None
        );
        assert_eq!(
            runtime.observe(&settings, &t, true, start + Duration::from_secs(23)),
            Some(false)
        );
        settings.start_on_load.enabled = false;
        t.running = Some(true);
        assert_eq!(
            runtime.observe(&settings, &t, true, start + Duration::from_secs(30)),
            None
        );
        assert_eq!(
            runtime.observe(&settings, &t, true, start + Duration::from_secs(40)),
            None
        );
    }

    #[test]
    fn thresholds_must_hold_continuously_use_signed_values_and_rearm_after_false() {
        let mut settings = Settings::default();
        settings.mode = Mode::Threshold;
        settings.start_threshold = ThresholdRule {
            enabled: true,
            parameter: Parameter::Current,
            comparison: Comparison::Less,
            value: -0.1,
            hold_seconds: 1.5,
        };
        let mut runtime = Runtime::default();
        let now = Instant::now();
        let mut t = telemetry();
        t.running = None;
        t.current = -0.2;
        assert_eq!(runtime.observe(&settings, &t, false, now), None);
        t.current = -0.1;
        assert_eq!(
            runtime.observe(&settings, &t, false, now + Duration::from_secs(1)),
            None
        );
        t.current = -0.2;
        assert_eq!(
            runtime.observe(&settings, &t, false, now + Duration::from_secs(2)),
            None
        );
        assert_eq!(
            runtime.observe(&settings, &t, false, now + Duration::from_millis(3499)),
            None
        );
        assert_eq!(
            runtime.observe(&settings, &t, false, now + Duration::from_millis(3500)),
            Some(true)
        );
        assert_eq!(
            runtime.observe(&settings, &t, false, now + Duration::from_secs(20)),
            None
        );
        t.current = f64::NAN;
        assert_eq!(
            runtime.observe(&settings, &t, false, now + Duration::from_secs(21)),
            None
        );
        t.current = -0.3;
        assert_eq!(
            runtime.observe(&settings, &t, false, now + Duration::from_secs(22)),
            None
        );
        assert_eq!(
            runtime.observe(&settings, &t, false, now + Duration::from_millis(23500)),
            Some(true)
        );
    }

    #[test]
    fn off_disabled_and_unknown_device_states_never_trigger_and_stop_wins_overlap() {
        let mut settings = Settings::from_legacy(true);
        let mut runtime = Runtime::default();
        let now = Instant::now();
        let mut t = telemetry();
        t.running = None;
        assert_eq!(runtime.observe(&settings, &t, true, now), None);
        t.running = Some(true);
        assert_eq!(runtime.observe(&settings, &t, false, now), None);
        settings.mode = Mode::Threshold;
        assert_eq!(runtime.observe(&settings, &t, false, now), None);
        settings.start_threshold = ThresholdRule {
            enabled: true,
            parameter: Parameter::Power,
            comparison: Comparison::Greater,
            value: 5.0,
            hold_seconds: 0.0,
        };
        settings.stop_threshold = ThresholdRule {
            enabled: true,
            parameter: Parameter::Voltage,
            comparison: Comparison::Less,
            value: 13.0,
            hold_seconds: 0.0,
        };
        assert_eq!(runtime.observe(&settings, &t, false, now), Some(false));
        assert_eq!(
            runtime.observe(&settings, &t, false, now + Duration::from_secs(10)),
            None
        );
        settings.mode = Mode::Off;
        assert_eq!(
            runtime.observe(&settings, &t, true, now + Duration::from_secs(20)),
            None
        );
    }

    #[test]
    fn configuration_rejects_negative_nonfinite_times_and_thresholds() {
        for value in [-0.1, f64::NAN, f64::INFINITY] {
            let mut settings = Settings::default();
            settings.start_on_load.delay_seconds = value;
            assert!(settings.validate().is_err());
            settings.start_on_load.delay_seconds = 0.0;
            settings.stop_threshold.hold_seconds = value;
            assert!(settings.validate().is_err());
        }
        let mut settings = Settings::default();
        settings.start_threshold.value = f64::NAN;
        assert!(settings.validate().is_err());
        settings.start_threshold.value = -2.5;
        assert!(settings.validate().is_ok());
        settings.start_threshold.hold_seconds = 0.15;
        assert!(settings.validate().is_err());
        settings.start_threshold.hold_seconds = 0.1;
        assert!(settings.validate().is_ok());
        assert_eq!(
            serde_json::from_str::<Settings>("{}").unwrap(),
            Settings::default()
        );
    }

    #[test]
    fn threshold_policy_controls_usb_and_ble_buffers_and_csv_without_device_writes() {
        for transport in [crate::TransportKind::Usb, crate::TransportKind::Bluetooth] {
            let root = std::env::temp_dir().join(format!(
                "atorch_threshold_{}_{transport:?}_{}",
                std::process::id(),
                crate::now_ms()
            ));
            let manager = crate::DeviceManager::default();
            {
                let mut state = manager.state.lock().unwrap();
                state.connected = true;
                state.device = Some(crate::DeviceInfo {
                    path: "threshold-test".into(),
                    name: "BW150".into(),
                    serial: "fixture".into(),
                    vendor_id: 0,
                    product_id: 0,
                    transport,
                    rssi: None,
                });
            }
            let mut settings = Settings::default();
            settings.mode = Mode::Threshold;
            settings.start_threshold = ThresholdRule {
                enabled: true,
                value: 12.0,
                ..ThresholdRule::default()
            };
            settings.stop_threshold = ThresholdRule {
                enabled: true,
                parameter: Parameter::Current,
                comparison: Comparison::Less,
                value: 0.1,
                hold_seconds: 0.0,
            };
            manager.set_auto_recording(settings).unwrap();
            assert!(manager.snapshot().sampling_paused);
            let mut recorder = crate::recorder::Recorder::new(root.clone());
            let mut t = telemetry();
            t.running = None;
            crate::accept_report(
                crate::Report::Telemetry(t.clone()),
                &manager.state,
                &manager.samples,
                &mut recorder,
            )
            .unwrap();
            assert!(manager.samples().is_empty());
            assert!(manager.snapshot().recording.is_none());
            t.voltage = 13.0;
            crate::accept_report(
                crate::Report::Telemetry(t.clone()),
                &manager.state,
                &manager.samples,
                &mut recorder,
            )
            .unwrap();
            assert!(!manager.snapshot().sampling_paused);
            assert_eq!(manager.samples().len(), 1);
            let path = manager.snapshot().recording.unwrap();
            t.current = 0.0;
            for _ in 0..3 {
                crate::accept_report(
                    crate::Report::Telemetry(t.clone()),
                    &manager.state,
                    &manager.samples,
                    &mut recorder,
                )
                .unwrap();
            }
            assert!(manager.snapshot().sampling_paused);
            assert!(manager.snapshot().recording_paused);
            assert_eq!(manager.samples().len(), 1);
            manager.set_sampling(true).unwrap();
            assert!(!manager.snapshot().sampling_paused);
            assert!(!manager.snapshot().recording_paused);
            assert_eq!(manager.snapshot().telemetry.unwrap().current, 0.0);
            for _ in 0..3 {
                crate::accept_report(
                    crate::Report::Telemetry(t.clone()),
                    &manager.state,
                    &manager.samples,
                    &mut recorder,
                )
                .unwrap();
            }
            assert!(!manager.snapshot().sampling_paused);
            assert_eq!(manager.samples().len(), 4);
            assert_eq!(manager.snapshot().recording.as_deref(), Some(path.as_str()));
            assert_eq!(std::fs::read_to_string(&path).unwrap().lines().count(), 5);
            t.current = 0.5;
            crate::accept_report(
                crate::Report::Telemetry(t.clone()),
                &manager.state,
                &manager.samples,
                &mut recorder,
            )
            .unwrap();
            t.current = 0.0;
            crate::accept_report(
                crate::Report::Telemetry(t),
                &manager.state,
                &manager.samples,
                &mut recorder,
            )
            .unwrap();
            assert!(manager.snapshot().sampling_paused);
            assert!(manager.snapshot().recording_paused);
            assert_eq!(manager.samples().len(), 5);
            drop(recorder);
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn policy_persists_independently_migrates_legacy_and_rejects_invalid_changes_atomically() {
        let root = std::env::temp_dir().join(format!(
            "atorch_threshold_preferences_{}_{}",
            std::process::id(),
            crate::now_ms()
        ));
        let path = root.join("sampling.json");
        let manager = crate::DeviceManager::with_sampling_preferences(path.clone());
        let mut settings = Settings::default();
        settings.mode = Mode::Threshold;
        settings.start_threshold.enabled = true;
        settings.start_threshold.value = 4.2;
        settings.start_threshold.hold_seconds = 1.2;
        settings.stop_on_load.delay_seconds = 2.5;
        manager.set_auto_recording(settings.clone()).unwrap();
        manager.set_usb_sample_rate(5).unwrap();
        let restored = crate::DeviceManager::with_sampling_preferences(path.clone());
        assert_eq!(restored.snapshot().auto_recording, settings);
        assert_eq!(restored.snapshot().usb_sample_rate_hz, 5);
        let bytes = std::fs::read(&path).unwrap();
        let mut invalid = settings.clone();
        invalid.start_threshold.hold_seconds = -1.0;
        assert!(restored.set_auto_recording(invalid).is_err());
        assert_eq!(restored.snapshot().auto_recording, settings);
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        std::fs::write(&path, r#"{"usbSampleRateHz":2,"autoRecordOnLoad":true}"#).unwrap();
        assert_eq!(
            crate::DeviceManager::with_sampling_preferences(path.clone())
                .snapshot()
                .auto_recording,
            Settings::from_legacy(true)
        );
        std::fs::write(&path, r#"{"usbSampleRateHz":2,"autoRecordOnLoad":true,"autoRecording":{"mode":"threshold","startThreshold":{"holdSeconds":-1}}}"#).unwrap();
        let invalid = crate::DeviceManager::with_sampling_preferences(path);
        assert_eq!(invalid.snapshot().auto_recording.mode, Mode::Off);
        assert_eq!(invalid.snapshot().usb_sample_rate_hz, 2);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn manual_resume_does_not_rearm_a_consumed_stop_and_manual_pause_masks_start() {
        let settings = Settings::from_legacy(true);
        let mut runtime = Runtime::default();
        let now = Instant::now();
        let mut t = telemetry();
        t.running = Some(true);
        assert_eq!(runtime.observe(&settings, &t, true, now), Some(true));
        runtime.manual_sampling(false);
        assert_eq!(
            runtime.observe(&settings, &t, true, now + Duration::from_secs(10)),
            None
        );
        t.running = Some(false);
        assert_eq!(
            runtime.observe(&settings, &t, true, now + Duration::from_secs(11)),
            Some(false)
        );
        runtime.manual_sampling(true);
        assert_eq!(
            runtime.observe(&settings, &t, true, now + Duration::from_secs(12)),
            None
        );
        t.running = Some(true);
        assert_eq!(
            runtime.observe(&settings, &t, true, now + Duration::from_secs(13)),
            Some(true)
        );
        // Manual pause also cancels a start condition still waiting for its hold.
        let mut settings = settings;
        settings.start_on_load.delay_seconds = 2.0;
        let mut runtime = Runtime::default();
        assert_eq!(runtime.observe(&settings, &t, true, now), None);
        runtime.manual_sampling(false);
        assert_eq!(
            runtime.observe(&settings, &t, true, now + Duration::from_secs(5)),
            None
        );
    }

    #[test]
    fn manual_resume_keeps_an_unfinished_stop_hold_and_false_restarts_it() {
        let mut settings = Settings::from_legacy(true);
        settings.stop_on_load.delay_seconds = 1.0;
        let mut runtime = Runtime::default();
        let now = Instant::now();
        let mut t = telemetry();
        assert_eq!(runtime.observe(&settings, &t, true, now), None);
        runtime.manual_sampling(true);
        assert_eq!(
            runtime.observe(&settings, &t, true, now + Duration::from_millis(500)),
            None
        );
        assert_eq!(
            runtime.observe(&settings, &t, true, now + Duration::from_secs(1)),
            Some(false)
        );
        runtime.manual_sampling(true);
        assert_eq!(
            runtime.observe(&settings, &t, true, now + Duration::from_secs(2)),
            None
        );
        t.running = Some(true);
        assert_eq!(
            runtime.observe(&settings, &t, true, now + Duration::from_secs(3)),
            Some(true)
        );
        t.running = Some(false);
        assert_eq!(
            runtime.observe(&settings, &t, true, now + Duration::from_secs(4)),
            None
        );
        assert_eq!(
            runtime.observe(&settings, &t, true, now + Duration::from_secs(5)),
            Some(false)
        );
    }
}
