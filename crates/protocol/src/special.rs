//! Dedicated test views and the vendor's CDC/CDCDC prompt protocol.
//! This module never infers a charge phase, pass/fail, or completion from a code
//! whose meaning has not been recovered. Result values retain their wire units.
use crate::{Command, DeviceSettings, Telemetry};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptContext {
    pub status: u8,
    pub code: u8,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageAction {
    pub value: u8,
    pub label: String,
    pub clears_data: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagePrompt {
    pub context: PromptContext,
    pub kind: u8,
    pub selection: u8,
    pub actions: Vec<StageAction>,
}

pub fn prompt(mode: u8, t: &Telemetry) -> Option<StagePrompt> {
    let code = t.stage_code?;
    if !matches!(mode, 7 | 8) || t.status == 0 || code / 10 == 0 {
        return None;
    }
    let action = |value, label: &str, clears_data| StageAction {
        value,
        label: label.into(),
        clears_data,
    };
    // CDPopTips::setMode: kind 2 hides Btn2, so Btn3 also emits 2.
    // Kind 3 shows Btn2 (resume=2), and Btn3 emits 3 (new discharge).
    let actions = match code / 10 {
        2 => vec![
            action(1, "返回", false),
            action(2, "清除数据并开始新一轮放电", true),
            action(5, "确认", false),
        ],
        3 => vec![
            action(1, "返回", false),
            action(2, "继续上一轮放电", false),
            action(3, "清除数据并开始新一轮放电", true),
            action(5, "确认", false),
        ],
        // Unknown prompt variants remain visible without invented actions.
        _ => vec![],
    };
    Some(StagePrompt {
        context: PromptContext {
            status: t.status,
            code,
        },
        kind: code / 10,
        selection: code % 10,
        actions,
    })
}

pub fn validate_stage(
    command: &Command,
    settings: &DeviceSettings,
    t: &Telemetry,
) -> Result<(), String> {
    if command.expected_mode != Some(settings.mode) {
        return Err("阶段操作缺少当前模式，请重新读取设备".into());
    }
    let prompt = prompt(settings.mode, t).ok_or("设备当前没有可操作的阶段提示")?;
    if command.expected_prompt != Some(prompt.context) {
        return Err("设备阶段提示已变化，请核对后重新选择".into());
    }
    if !prompt
        .actions
        .iter()
        .any(|a| a.value as f64 == command.value)
    {
        return Err("此阶段提示不支持该操作".into());
    }
    if prompt
        .actions
        .iter()
        .any(|a| a.value as f64 == command.value && a.value != 1)
    {
        validate_cycle_settings(settings)?;
    }
    Ok(())
}

pub fn validate_cycle_settings(s: &DeviceSettings) -> Result<(), String> {
    if !s.target.is_some_and(|v| v.is_finite() && v > 0.0)
        || !s.cutoff_voltage.is_finite()
        || s.cutoff_voltage <= 0.0
        || !s.full_voltage.is_finite()
        || s.full_voltage <= s.cutoff_voltage
        || !s.cutoff_current.is_finite()
        || s.cutoff_current <= 0.0
    {
        return Err("请先核对放电电流、截止电压、充满电压和充电截止电流".into());
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpecialReading {
    pub mode: u8,
    pub timestamp: u64,
    pub running: Option<bool>,
    pub status: u8,
    pub stage_code: Option<u8>,
    pub prompt: Option<StagePrompt>,
    pub voltage: f64,
    pub current: f64,
    pub power: f64,
    pub resistance: Option<f64>,
    pub energy: Option<f64>,
    pub capacity: f64,
}

pub fn reading(mode: u8, t: &Telemetry) -> Option<SpecialReading> {
    if !(4..=9).contains(&mode) || t.stage_code.is_none() {
        return None;
    }
    Some(SpecialReading {
        mode,
        timestamp: t.timestamp,
        running: t.running,
        status: t.status,
        stage_code: t.stage_code,
        prompt: prompt(mode, t),
        voltage: t.voltage,
        current: t.current,
        power: t.power,
        resistance: t.resistance,
        energy: t.energy,
        capacity: t.capacity,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prompt_kind_controls_resume_and_new_discharge_codes() {
        let mut t = Telemetry {
            status: 8,
            stage_code: Some(21),
            ..Default::default()
        };
        let p = prompt(7, &t).unwrap();
        assert_eq!((p.kind, p.selection), (2, 1));
        assert_eq!(
            p.actions.iter().map(|a| a.value).collect::<Vec<_>>(),
            [1, 2, 5]
        );
        assert!(p.actions[1].clears_data);
        t.stage_code = Some(32);
        let p = prompt(8, &t).unwrap();
        assert_eq!(
            p.actions.iter().map(|a| a.value).collect::<Vec<_>>(),
            [1, 2, 3, 5]
        );
        assert!(!p.actions[1].clears_data);
        assert!(p.actions[2].clears_data);
        assert!(prompt(9, &t).is_none());
        t.stage_code = Some(91);
        assert!(prompt(7, &t).unwrap().actions.is_empty());
        t.status = 0;
        assert!(prompt(7, &t).is_none());
    }
    #[test]
    fn stale_prompt_and_unsafe_charge_settings_block_actions() {
        let mut s = DeviceSettings {
            mode: 7,
            target: Some(1.0),
            cutoff_voltage: 3.0,
            full_voltage: 4.2,
            cutoff_current: 0.05,
            ..Default::default()
        };
        let t = Telemetry {
            status: 8,
            stage_code: Some(32),
            ..Default::default()
        };
        let mut c = Command {
            kind: "stage".into(),
            value: 2.0,
            expected_mode: Some(7),
            expected_prompt: Some(PromptContext {
                status: 8,
                code: 31,
            }),
        };
        assert!(validate_stage(&c, &s, &t).unwrap_err().contains("已变化"));
        c.expected_prompt.as_mut().unwrap().code = 32;
        validate_stage(&c, &s, &t).unwrap();
        assert_eq!(
            &c.encode(1).unwrap()[..10],
            &[0x55, 5, 1, 0x35, 2, 0, 0, 0, 0xee, 0xff]
        );
        assert!(!c.matches(&crate::Report::Ack {
            address: 1,
            status: 1
        }));
        s.full_voltage = 2.0;
        assert!(validate_stage(&c, &s, &t).is_err());
        c.value = 1.0;
        validate_stage(&c, &s, &t).unwrap();
        assert!(!c.matches(&crate::Report::Telemetry(t)));
        assert!(c.matches(&crate::Report::Telemetry(Telemetry {
            stage_code: Some(0),
            ..Default::default()
        })));
    }
    #[test]
    fn dedicated_readings_preserve_units_zero_and_unknown_status() {
        let t = Telemetry {
            voltage: 12.5,
            current: -1.2,
            power: 15.0,
            resistance: Some(0.042),
            energy: Some(0.0),
            capacity: 0.0,
            status: 0xfe,
            stage_code: Some(0),
            ..Default::default()
        };
        for mode in 4..=9 {
            let r = reading(mode, &t).unwrap();
            assert_eq!(
                (r.resistance, r.current, r.energy, r.status),
                (Some(0.042), -1.2, Some(0.0), 0xfe)
            );
        }
        assert!(reading(0, &t).is_none());
        assert!(reading(4, &Telemetry::default()).is_none());
    }
}
