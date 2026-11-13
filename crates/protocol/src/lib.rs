//! BW-series protocol recovered from vendor V1.0.8 and a connected BW150.
//! Wire offsets and evidence are documented in docs/protocol.md.
use serde::{Deserialize, Serialize};
use thiserror::Error;
pub mod ble;
pub mod firmware;
pub mod special;

pub const VENDOR_ID: u16 = 0x0483;
pub const PRODUCT_ID: u16 = 0x5750;
pub const REPORT_SIZE: usize = 64;

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("Invalid report length, header, address or terminator")]
    InvalidFrame,
    #[error("Unsupported report type: {0:#04x}")]
    UnknownReport(u8),
    #[error("Invalid parameter: {0}")]
    InvalidParameter(String),
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Telemetry {
    pub timestamp: u64,
    pub voltage: f64,
    pub current: f64,
    pub power: f64,
    pub energy: Option<f64>,
    pub capacity: f64,
    pub resistance: Option<f64>,
    pub cpu_temperature: Option<f64>,
    pub ntc_temperature: Option<f64>,
    pub mos_temperature: Option<f64>,
    pub fan_speed: Option<f64>,
    pub running: Option<bool>,
    pub status: u8,
    /// USB report byte 54; decimal tens/ones are vendor prompt kind/selection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage_code: Option<u8>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSettings {
    pub cutoff_voltage: f64,
    pub target: Option<f64>,
    pub voltage_calibration: f64,
    pub current_calibration: f64,
    pub temperature_calibration: f64,
    pub full_voltage: f64,
    pub cutoff_current: f64,
    pub over_current: f64,
    pub over_power: f64,
    pub ntc_limit: f64,
    pub mos_limit: f64,
    pub mode: u8,
    pub language: u8,
    pub brightness: u8,
    pub standby_brightness: u8,
    pub standby_seconds: u8,
    pub limit_hours: u8,
    pub limit_minutes: u8,
}

#[derive(Debug, Clone)]
pub enum Report {
    Telemetry(Telemetry),
    Settings(DeviceSettings),
    Ack { address: u8, status: u8 },
}

pub fn query(address: u8, report_type: u8) -> [u8; REPORT_SIZE] {
    let mut data = [0; REPORT_SIZE];
    data[..9].copy_from_slice(&[0x55, 0x05, address, report_type, 0x0b, 0, 0x8c, 0xee, 0xff]);
    data
}

pub fn parse(data: &[u8], address: u8, timestamp: u64) -> Result<Report, ProtocolError> {
    if data.len() != REPORT_SIZE || data[..2] != [0xaa, 0x05] || data[2] != address {
        return Err(ProtocolError::InvalidFrame);
    }
    if data[3] == 4 {
        if data[8..10] != [0xee, 0xff] {
            return Err(ProtocolError::InvalidFrame);
        }
        return Ok(Report::Ack {
            address: data[2],
            status: data[4],
        });
    }
    if data[62..] != [0xee, 0xff] {
        return Err(ProtocolError::InvalidFrame);
    }
    let unsigned = |offset: usize| {
        u32::from_le_bytes(data[offset..offset + 4].try_into().unwrap()) as f64 / 1000.0
    };
    let signed = |offset, mask| unsigned(offset) * if data[60] & mask != 0 { -1.0 } else { 1.0 };
    match data[3] {
        5 => Ok(Report::Telemetry(Telemetry {
            timestamp,
            voltage: unsigned(8),
            current: signed(12, 0x80),
            power: unsigned(16),
            // Wire order follows the vendor's CSV: V, A, W, Ω, Wh, mAh.
            resistance: Some(unsigned(20)),
            energy: Some(unsigned(24)),
            capacity: unsigned(28),
            cpu_temperature: Some(signed(32, 0x40)),
            ntc_temperature: Some(signed(36, 0x20)),
            mos_temperature: Some(signed(40, 0x10)),
            fan_speed: Some(unsigned(44)),
            running: Some(data[52] != 0),
            status: data[53],
            stage_code: Some(data[54]),
        })),
        3 => {
            let has_target = matches!(data[48], 0..=3 | 7 | 8);
            let mut numbers = [0.0; 11];
            for (i, value) in numbers.iter_mut().enumerate() {
                if i == 0 && !has_target {
                    continue;
                }
                *value = f32::from_be_bytes(data[4 + i * 4..8 + i * 4].try_into().unwrap()) as f64;
                if !value.is_finite() {
                    return Err(ProtocolError::InvalidFrame);
                }
            }
            Ok(Report::Settings(DeviceSettings {
                // The reply follows command order: 26 temperature, 27 voltage,
                // 28 current calibration, then 29 cutoff. It is not UI order.
                cutoff_voltage: numbers[4],
                target: has_target.then_some(numbers[0]),
                voltage_calibration: numbers[2],
                current_calibration: numbers[3],
                temperature_calibration: numbers[1],
                full_voltage: numbers[5],
                cutoff_current: numbers[6],
                over_current: numbers[7],
                over_power: numbers[8],
                ntc_limit: numbers[9],
                mos_limit: numbers[10],
                mode: data[48],
                language: data[49],
                brightness: data[50],
                standby_brightness: data[51],
                standby_seconds: data[52],
                limit_hours: data[53],
                limit_minutes: data[54],
            }))
        }
        other => Err(ProtocolError::UnknownReport(other)),
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    pub kind: String,
    pub value: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_mode: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_prompt: Option<special::PromptContext>,
}

impl Command {
    pub fn matches(&self, report: &Report) -> bool {
        let close = |n: f64| (n - self.value).abs() <= 0.00001_f64.max(self.value.abs() * 0.000001);
        match report {
            Report::Telemetry(t) => match self.kind.as_str() {
                "running" => t.running == Some(self.value != 0.0),
                "clearCounters" => t.energy == Some(0.0) && t.capacity == 0.0,
                "stage" => {
                    // ACK only acknowledges receipt. The device must dismiss its prompt.
                    t.status == 0
                        && t.stage_code.is_some()
                        && (matches!(self.value, 1.0 | 5.0) || t.running == Some(true))
                }
                _ => false,
            },
            Report::Settings(s) => match self.kind.as_str() {
                "target" => s.target.is_some_and(close),
                "mode" => close(s.mode as f64),
                "cutoffVoltage" => close(s.cutoff_voltage),
                "fullVoltage" => close(s.full_voltage),
                "cutoffCurrent" => close(s.cutoff_current),
                "overCurrent" => close(s.over_current),
                "overPower" => close(s.over_power),
                "ntcLimit" => close(s.ntc_limit),
                "mosLimit" => close(s.mos_limit),
                "voltageCalibration" => close(s.voltage_calibration),
                "currentCalibration" => close(s.current_calibration),
                "temperatureCalibration" => close(s.temperature_calibration),
                "brightness" => close(s.brightness as f64),
                "standbyBrightness" => close(s.standby_brightness as f64),
                "standbySeconds" => close(s.standby_seconds as f64),
                "limitHours" => close(s.limit_hours as f64),
                "limitMinutes" => close(s.limit_minutes as f64),
                "language" => close(s.language as f64),
                _ => false,
            },
            // A mode selection is complete only when the requested mode is read back.
            Report::Ack { status, .. } => {
                !matches!(self.kind.as_str(), "mode" | "stage") && *status == 1
            }
        }
    }
    pub fn encode(&self, address: u8) -> Result<[u8; REPORT_SIZE], ProtocolError> {
        let value = self.value;
        if !value.is_finite() {
            return Err(ProtocolError::InvalidParameter(self.kind.clone()));
        }
        let mut frame = [0; REPORT_SIZE];
        frame[..3].copy_from_slice(&[0x55, 0x05, address]);
        frame[8..10].copy_from_slice(&[0xee, 0xff]);
        if self.kind == "stage" {
            if value.fract() != 0.0 || !matches!(value as i32, 1 | 2 | 3 | 5) {
                return Err(ProtocolError::InvalidParameter(self.kind.clone()));
            }
            frame[3] = 0x35;
            frame[4] = value as u8;
            return Ok(frame);
        }
        if self.kind == "mode" {
            if value.fract() != 0.0 || !(0.0..=9.0).contains(&value) {
                return Err(ProtocolError::InvalidParameter(self.kind.clone()));
            }
            // Vendor MainDialog::buttonClicked -> 0x40e080, CC through CDxn.
            frame[3] = 0x47 + value as u8;
            return Ok(frame);
        }
        let (opcode, bounds) = match self.kind.as_str() {
            "target" => (0x21, (0.0, 99999.0)),
            // Vendor temperature calibration slider: 500..2000 divided by 1000.
            // This is a dimensionless coefficient, not a Celsius offset.
            "temperatureCalibration" => (0x26, (0.5, 2.0)),
            "voltageCalibration" => (0x27, (0.01, 10.0)),
            "currentCalibration" => (0x28, (0.01, 10.0)),
            "cutoffVoltage" => (0x29, (0.0, 500.0)),
            "fullVoltage" => (0x2a, (0.0, 500.0)),
            "cutoffCurrent" => (0x2b, (0.0, 1500.0)),
            "overCurrent" => (0x2c, (0.0, 1500.0)),
            "overPower" => (0x2d, (0.0, 420000.0)),
            "ntcLimit" => (0x2e, (0.0, 300.0)),
            "mosLimit" => (0x2f, (0.0, 300.0)),
            "clearCurrent" | "factoryReset" | "clearCounters" => {
                if value != 0.0 {
                    return Err(ProtocolError::InvalidParameter(self.kind.clone()));
                }
                frame[3] = match self.kind.as_str() {
                    "clearCurrent" => 0x32,
                    "factoryReset" => 0x33,
                    _ => 0x34,
                };
                return Ok(frame);
            }
            "running" | "brightness" | "standbyBrightness" | "standbySeconds" | "language"
            | "limitHours" | "limitMinutes" => {
                if value.fract() != 0.0 || !(0.0..=255.0).contains(&value) {
                    return Err(ProtocolError::InvalidParameter(self.kind.clone()));
                }
                let v = value as u8;
                match self.kind.as_str() {
                    "running" if v <= 1 => {
                        frame[3] = 0x25;
                        frame[4] = v;
                    }
                    "language" if (1..=4).contains(&v) => {
                        frame[3] = 0x20;
                        frame[4] = v;
                    }
                    "brightness" if v <= 10 => {
                        frame[3] = 0x22;
                        frame[7] = v;
                    }
                    "standbyBrightness" if v <= 10 => {
                        frame[3] = 0x23;
                        frame[7] = v;
                    }
                    "standbySeconds" => {
                        frame[3] = 0x24;
                        frame[7] = v;
                    }
                    "limitHours" => {
                        frame[3] = 0x31;
                        frame[4] = v;
                        frame[7] = 1;
                    }
                    "limitMinutes" if v < 60 => {
                        frame[3] = 0x31;
                        frame[4] = v;
                        frame[7] = 2;
                    }
                    _ => return Err(ProtocolError::InvalidParameter(self.kind.clone())),
                }
                return Ok(frame);
            }
            _ => return Err(ProtocolError::InvalidParameter(self.kind.clone())),
        };
        if !(bounds.0..=bounds.1).contains(&value) {
            return Err(ProtocolError::InvalidParameter(self.kind.clone()));
        }
        frame[3] = opcode;
        frame[4..8].copy_from_slice(&(value as f32).to_be_bytes());
        Ok(frame)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }
    #[test]
    fn captured_bw150_configuration() {
        let bytes=hex("aa0501034053332f3f8000003f7df0163f7b24e7401ffffe408666663d4ccccd4180000043c8000042c8000042c80000000109043c020066666666666666eeff");
        let Report::Settings(s) = parse(&bytes, 1, 0).unwrap() else {
            panic!()
        };
        assert!((s.target.unwrap() - 3.3).abs() < 0.00001);
        assert!((s.cutoff_voltage - 2.5).abs() < 0.00001);
        assert_eq!(s.temperature_calibration, 1.0);
        assert!((s.voltage_calibration - 0.99194467).abs() < 0.00001);
        assert!((s.current_calibration - 0.98103184).abs() < 0.00001);
        assert_eq!((s.over_current, s.over_power), (16.0, 400.0));
        assert_eq!(
            (s.mode, s.language, s.brightness, s.limit_hours),
            (0, 1, 9, 2)
        );
    }
    #[test]
    fn cutoff_and_temperature_commands_match_their_own_reply_fields() {
        let mut bytes=hex("aa0501033f8000003f8000003f7df0163f7b24e7401ffffe408666663d4ccccd4180000043c8000042c8000042c80000000109043c020066666666666666eeff");
        // Offset 8 is the coefficient; offset 20 is the cutoff. Use distinct
        // values to catch a field swap in both parsing and write confirmation.
        for (kind, offset, value, expected) in [
            ("temperatureCalibration", 8, 1.25, "550501263fa00000eeff"),
            ("cutoffVoltage", 20, 3.125, "5505012940480000eeff"),
        ] {
            let command = Command {
                kind: kind.into(),
                value,
                ..Default::default()
            };
            assert_eq!(&command.encode(1).unwrap()[..10], &hex(expected));
            let previous = parse(&bytes, 1, 0).unwrap();
            assert!(!command.matches(&previous));
            bytes[offset..offset + 4].copy_from_slice(&(value as f32).to_be_bytes());
            assert!(command.matches(&parse(&bytes, 1, 0).unwrap()));
        }
        let Report::Settings(s) = parse(&bytes, 1, 0).unwrap() else {
            panic!()
        };
        assert_eq!(s.temperature_calibration, 1.25);
        assert_eq!(s.cutoff_voltage, 3.125);
    }
    #[test]
    fn temperature_calibration_uses_the_vendor_coefficient_range() {
        for value in [-100.0, -1.0, 0.0, 0.4999, 2.0001, 100.0] {
            assert!(Command {
                kind: "temperatureCalibration".into(),
                value,
                ..Default::default()
            }
            .encode(1)
            .is_err());
        }
        for value in [0.5, 1.0, 2.0] {
            assert!(Command {
                kind: "temperatureCalibration".into(),
                value,
                ..Default::default()
            }
            .encode(1)
            .is_ok());
        }
    }
    #[test]
    fn captured_bw150_telemetry() {
        let bytes=hex("aa050105000000000000000005000000000000000000000080fa0100c2b26400187900009f510000af660000000000000000000000000000000000008000eeff");
        let Report::Telemetry(t) = parse(&bytes, 1, 42).unwrap() else {
            panic!()
        };
        assert_eq!(
            (
                t.voltage,
                t.current,
                t.capacity,
                t.cpu_temperature,
                t.fan_speed
            ),
            (0.0, -0.005, 6599.362, Some(31.0), Some(0.0))
        );
        assert_eq!((t.energy, t.resistance), (Some(129.664), Some(0.0)));
        assert_eq!(t.timestamp, 42);
        assert_eq!(t.running, Some(false));
    }

    #[test]
    fn special_mode_payload_is_not_presented_as_a_float_target() {
        let mut bytes=hex("aa050103000000033f8000003f7df0163f7b24e7401ffffe408666663d4ccccd4180000043c8000042c8000042c80000040109043c020066666666666666eeff");
        for mode in [4, 5, 6, 9] {
            bytes[48] = mode;
            let Report::Settings(s) = parse(&bytes, 1, 0).unwrap() else {
                panic!()
            };
            assert_eq!(s.mode, mode);
            assert!(s.target.is_none());
            // An unknown special payload may have a non-float bit pattern.
            bytes[4..8].fill(0xff);
            assert!(parse(&bytes, 1, 0).is_ok());
        }
    }
    #[test]
    fn rejects_malformed_and_non_finite_data() {
        assert!(parse(&[0; 63], 1, 0).is_err());
        let mut f = [0; 64];
        f[..4].copy_from_slice(&[0xaa, 5, 1, 3]);
        f[62..].copy_from_slice(&[0xee, 0xff]);
        f[4..8].copy_from_slice(&f32::NAN.to_be_bytes());
        assert!(parse(&f, 1, 0).is_err());
        assert!(Command {
            kind: "target".into(),
            value: f64::NAN,
            ..Default::default()
        }
        .encode(1)
        .is_err());
        assert!(Command {
            kind: "running".into(),
            value: 2.0,
            ..Default::default()
        }
        .encode(1)
        .is_err());
    }
    #[test]
    fn encodes_vendor_compatible_control_and_query() {
        assert_eq!(&query(1, 5)[..9], &hex("550501050b008ceeff"));
        assert_eq!(
            &Command {
                kind: "target".into(),
                value: 1.0,
                ..Default::default()
            }
            .encode(1)
            .unwrap()[..10],
            &hex("550501213f800000eeff")
        );
        assert_eq!(
            &Command {
                kind: "running".into(),
                value: 0.0,
                ..Default::default()
            }
            .encode(1)
            .unwrap()[..10],
            &hex("5505012500000000eeff")
        );
    }

    #[test]
    fn vendor_mode_commands_require_exact_settings_readback() {
        for mode in 0..=9 {
            let command = Command {
                kind: "mode".into(),
                value: mode as f64,
                ..Default::default()
            };
            let encoded = command.encode(1).unwrap();
            assert_eq!(
                &encoded[..10],
                &[0x55, 5, 1, 0x47 + mode, 0, 0, 0, 0, 0xee, 0xff]
            );
            assert!(encoded[10..].iter().all(|b| *b == 0));
            assert!(!command.matches(&Report::Ack {
                address: 1,
                status: 1
            }));
            assert!(command.matches(&Report::Settings(DeviceSettings {
                mode,
                ..Default::default()
            })));
            assert!(!command.matches(&Report::Settings(DeviceSettings {
                mode: (mode + 1) % 10,
                ..Default::default()
            })));
        }
        for value in [-1.0, 10.0, 0.5, f64::NAN, f64::INFINITY] {
            assert!(Command {
                kind: "mode".into(),
                value,
                ..Default::default()
            }
            .encode(1)
            .is_err());
        }
    }
}
