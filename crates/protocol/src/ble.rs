//! Legacy DC notifications and panel commands used by ATORCH loads with FFE0 / FFE1.
use crate::{ProtocolError, Telemetry};
use serde::{Deserialize, Serialize};

/// FFE0 is also advertised by unrelated devices. Match a known load name first.
pub fn is_supported_name(name: &str) -> bool {
    let name = name.trim();
    name.to_ascii_uppercase().starts_with("BW150")
        || crate::LoadModel::from_name(name) != crate::LoadModel::Standard
}

const HEADER: [u8; 4] = [0xff, 0x55, 0x01, 0x02];
pub const FRAME_SIZE: usize = 36;

/// Supported panel operations from the vendor's E-test app.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Command {
    KeySet,
    KeyOk,
    KeyPlus,
    KeyMinus,
    ClearEnergy,
    ClearCapacity,
    ClearTime,
}

impl Command {
    pub fn encode(self) -> [u8; 10] {
        let code = match self {
            Self::KeySet => 0x31,
            Self::KeyOk => 0x32,
            Self::KeyPlus => 0x33,
            Self::KeyMinus => 0x34,
            Self::ClearEnergy => 1,
            Self::ClearCapacity => 2,
            Self::ClearTime => 3,
        };
        let mut bytes = [0xff, 0x55, 0x11, 2, code, 0, 0, 0, 0, 0];
        bytes[9] = bytes[2..9].iter().fold(0u8, |sum, b| sum.wrapping_add(*b)) ^ 0x44;
        bytes
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::KeySet => "设置键 SET",
            Self::KeyOk => "确认键 OK",
            Self::KeyPlus => "加键 +",
            Self::KeyMinus => "减键 −",
            Self::ClearEnergy => "电量清零",
            Self::ClearCapacity => "容量清零",
            Self::ClearTime => "设备计时清零",
        }
    }
}

/// A transport must never turn into an arbitrary BLE write or USB tunnel.
pub fn validate_command(bytes: &[u8]) -> Result<(), String> {
    if [
        Command::KeySet,
        Command::KeyOk,
        Command::KeyPlus,
        Command::KeyMinus,
        Command::ClearEnergy,
        Command::ClearCapacity,
        Command::ClearTime,
    ]
    .into_iter()
    .any(|command| bytes == command.encode())
    {
        Ok(())
    } else {
        Err("不支持此 ATORCH 蓝牙面板命令".into())
    }
}

pub fn parse(data: &[u8], timestamp: u64) -> Result<Telemetry, ProtocolError> {
    if data.len() != FRAME_SIZE || data[..4] != HEADER {
        return Err(ProtocolError::InvalidFrame);
    }
    let be24 =
        |offset| u32::from_be_bytes([0, data[offset], data[offset + 1], data[offset + 2]]) as f64;
    let voltage = be24(4) / 10.0;
    let current = be24(7) / 1000.0;
    Ok(Telemetry {
        timestamp,
        voltage,
        current,
        power: voltage * current,
        capacity: be24(10) * 10.0, // E-test's DC Ah / 100, converted to mAh.
        // User-confirmed BW150 channel identity: the legacy temperature is MOS.
        mos_temperature: Some(u16::from_be_bytes([data[24], data[25]]) as f64),
        // The BW150's legacy energy field did not agree with USB during capture.
        // CPU/probe temperatures, resistance and load state are not established.
        energy: None,
        resistance: None,
        cpu_temperature: None,
        ntc_temperature: None,
        fan_speed: None,
        running: None,
        status: 0,
        stage_code: None,
    })
}

#[derive(Default)]
pub struct Decoder {
    pending: Vec<u8>,
}

impl Decoder {
    /// Notifications may split or coalesce frames. Retain only a bounded tail
    /// and resynchronise at the next DC frame header after loss/noise.
    pub fn push(&mut self, bytes: &[u8], timestamp: u64) -> Vec<Telemetry> {
        let mut reports = Vec::new();
        for &byte in bytes {
            self.pending.push(byte);
            if self.pending.len() > HEADER.len() && self.pending.ends_with(&HEADER) {
                self.pending.drain(..self.pending.len() - HEADER.len());
            }
            while self.pending.len() >= HEADER.len() && !self.pending.starts_with(&HEADER) {
                self.pending.remove(0);
            }
            if self.pending.len() == FRAME_SIZE {
                if let Ok(t) = parse(&self.pending, timestamp) {
                    reports.push(t);
                }
                self.pending.clear();
            }
        }
        reports
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn captured() -> Vec<u8> {
        let hex = "ff5501020000000000000002960000000000006400000000001a0001001c3c0000000023";
        hex.as_bytes()
            .chunks(2)
            .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
            .collect()
    }
    #[test]
    fn recognizes_supported_load_advertisements_and_rejects_other_ffe0_devices() {
        for name in [
            "DL24",
            "DL24_BLE",
            "dl24p-ble",
            "ATORCH DL24",
            "BW150_BLE",
            "BW600_BLE",
            "ATORCH BW600-DK",
        ] {
            assert!(is_supported_name(name), "{name}");
        }
        for name in ["DL240", "DL24EW", "BW6000", "HMSoft", "Not DL24", "ATORCH"] {
            assert!(!is_supported_name(name), "{name}");
        }
    }
    #[test]
    fn panel_commands_match_the_reference_apk_and_real_gatt_captures() {
        let cases = [
            (Command::KeySet, "ff551102310000000000"),
            (Command::KeyOk, "ff551102320000000001"),
            (Command::KeyPlus, "ff551102330000000002"),
            (Command::KeyMinus, "ff551102340000000003"),
            (Command::ClearEnergy, "ff551102010000000050"),
            (Command::ClearCapacity, "ff551102020000000051"),
            (Command::ClearTime, "ff551102030000000052"),
        ];
        for (command, expected) in cases {
            assert_eq!(
                command
                    .encode()
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect::<String>(),
                expected
            );
            assert!(validate_command(&command.encode()).is_ok());
            let mut corrupt = command.encode();
            corrupt[9] ^= 1;
            assert!(validate_command(&corrupt).is_err());
        }
        assert!(validate_command(&crate::query(1, 3)).is_err());
        assert!(validate_command(&[0xff, 0x55, 0x11, 2, 0x21, 0, 0, 0, 60, 0x2a]).is_err());
        let mut payload = Command::KeyPlus.encode();
        payload[8] = 1;
        payload[9] ^= 1;
        assert!(validate_command(&payload).is_err());
    }
    #[test]
    fn captured_bw150_legacy_dc_frame_has_explicit_gaps() {
        let t = parse(&captured(), 123).unwrap();
        assert_eq!(
            (t.voltage, t.current, t.power, t.capacity),
            (0.0, 0.0, 0.0, 6620.0)
        );
        assert_eq!(t.mos_temperature, Some(26.0));
        assert!(t.ntc_temperature.is_none());
        let serialized = serde_json::to_value(&t).unwrap();
        assert_eq!(serialized["mosTemperature"], 26.0);
        assert!(serialized.get("deviceTemperature").is_none());
        assert!(t.energy.is_none() && t.resistance.is_none() && t.running.is_none());
        assert!(t.cpu_temperature.is_none() && t.fan_speed.is_none());
    }
    #[test]
    fn legacy_dc_scaling_follows_the_vendor_decoder() {
        // Synthetic nonzero fields exercise the decoder's units, not hardware
        // validation at these voltages/currents.
        let mut f = captured();
        f[4..7].copy_from_slice(&[0, 0, 123]);
        f[7..10].copy_from_slice(&[0, 0x05, 0xdc]);
        let t = parse(&f, 1).unwrap();
        assert_eq!((t.voltage, t.current), (12.3, 1.5));
        assert!((t.power - 18.45).abs() < 1e-9);
        assert!(parse(&f[..35], 1).is_err());
        f[3] = 3;
        assert!(parse(&f, 1).is_err());
    }
    #[test]
    fn every_notification_split_and_coalesced_frames_decode_once() {
        let f = captured();
        for split in 0..=f.len() {
            let mut decoder = Decoder::default();
            let mut result = decoder.push(&f[..split], 1);
            result.extend(decoder.push(&f[split..], 2));
            assert_eq!(result.len(), 1, "split {split}");
        }
        let mut decoder = Decoder::default();
        assert_eq!(decoder.push(&[f.clone(), f].concat(), 3).len(), 2);
    }
    #[test]
    fn noise_and_truncated_frames_resynchronise_without_growing() {
        let mut decoder = Decoder::default();
        assert!(decoder.push(&vec![0x33; 10000], 0).is_empty());
        assert!(decoder.pending.len() < HEADER.len());
        decoder.push(&captured()[..20], 0);
        assert_eq!(decoder.push(&[captured(), captured()].concat(), 1).len(), 2);
        assert_eq!(decoder.push(&captured(), 2).len(), 1);
    }
}
