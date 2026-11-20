//! Load models and application limits checked before USB writes.
use atorch_protocol::{Command, DeviceSettings, LoadModel};
use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize)]
pub struct LoadLimits {
    pub voltage: f64,
    pub current: f64,
    pub power: f64,
}

impl LoadLimits {
    pub fn for_model(model: LoadModel) -> Self {
        match model {
            // USB identifies the family without identifying the installed power modules.
            LoadModel::Bw600 => Self {
                voltage: 200.0,
                current: 50.0,
                power: 1200.0,
            },
            _ => Self {
                voltage: 100.0,
                current: 20.0,
                power: 400.0,
            },
        }
    }
}

pub fn requires_settings(kind: &str) -> bool {
    matches!(
        kind,
        "target"
            | "cutoffVoltage"
            | "overCurrent"
            | "overPower"
            | "limitHours"
            | "limitMinutes"
            | "cycleCount"
            | "fullVoltage"
            | "cutoffCurrent"
            | "ntcLimit"
            | "mosLimit"
            | "brightness"
            | "standbyBrightness"
            | "standbySeconds"
    )
}

pub fn validate_dl24(command: &Command, settings: Option<&DeviceSettings>) -> Result<(), String> {
    match command.kind.as_str() {
        "mode" if command.value > 3.0 => Err("DL24 支持 CC、CV、CR、CP 四种模式".into()),
        "fullVoltage" | "cutoffCurrent" | "stage" => Err("DL24 不支持充电设置或阶段控制".into()),
        "target" | "running"
            if !(command.kind == "running" && command.value == 0.0)
                && settings.is_some_and(|settings| settings.mode > 3) =>
        {
            Err("请先将 DL24 切回 CC、CV、CR 或 CP 模式".into())
        }
        _ => Ok(()),
    }
}

fn rounded(value: f64, digits: i32) -> f64 {
    let scale = 10_f64.powi(digits);
    (value * scale).round() / scale
}

pub fn validate_cycle_start(settings: &DeviceSettings, limits: LoadLimits) -> Result<(), String> {
    atorch_protocol::special::validate_cycle_settings(settings)?;
    if settings.mode == 9 {
        let limit = rounded(settings.over_current, 3).min(limits.current);
        // The target here came from a float32 readback, not from typed input.
        if rounded(settings.target.unwrap_or_default(), 3) > limit {
            return Err(format!("放电电流超过 {limit} A，请核对充放电流上限"));
        }
    }
    Ok(())
}

pub fn validate(
    command: &Command,
    settings: &DeviceSettings,
    limits: LoadLimits,
) -> Result<(), String> {
    let target = settings.target.unwrap_or(0.0);
    let (label, min, max, digits) = match command.kind.as_str() {
        "target" => match settings.mode {
            0 | 9 => (
                "目标电流",
                0.0,
                rounded(settings.over_current, 3).min(limits.current),
                3,
            ),
            1 => (
                "目标电压",
                rounded(settings.cutoff_voltage, 2),
                limits.voltage,
                2,
            ),
            2 => ("目标电阻", 0.01, 9999.99, 2),
            3 => (
                "目标功率",
                0.0,
                rounded(settings.over_power, 1).min(limits.power),
                1,
            ),
            _ => return Ok(()),
        },
        "cutoffVoltage" => (
            "放电停止电压",
            0.0,
            if settings.mode == 1 {
                rounded(target, 2).min(limits.voltage)
            } else {
                limits.voltage
            },
            2,
        ),
        "overCurrent" => (
            "充放电流上限",
            if settings.mode == 0 || (settings.mode == 9 && settings.cycle_count.is_some()) {
                rounded(target, 3)
            } else {
                0.0
            },
            limits.current,
            3,
        ),
        "overPower" => (
            "充放功率上限",
            if settings.mode == 3 {
                rounded(target, 1)
            } else {
                0.0
            },
            limits.power,
            1,
        ),
        "fullVoltage" => ("充电停止电压", 0.0, 100.0, 2),
        "cutoffCurrent" => ("充电停止电流", 0.0, 20.0, 2),
        "ntcLimit" => ("探头温度上限", 0.0, 100.0, 0),
        "mosLimit" => ("MOS 温度上限", 0.0, 100.0, 0),
        "brightness" => ("工作亮度", 0.0, 9.0, 0),
        "standbyBrightness" => ("待机亮度", 0.0, 9.0, 0),
        "standbySeconds" => ("待机延时", 10.0, 60.0, 0),
        "limitHours" | "limitMinutes" => {
            let value = command.value;
            let max = if command.kind == "limitHours" {
                99.0
            } else {
                59.0
            };
            if !value.is_finite() || value.fract() != 0.0 || !(0.0..=max).contains(&value) {
                return Err("小时和分钟必须为范围内的整数（小时 0–99，分钟 0–59）".into());
            }
            let total = if command.kind == "limitHours" {
                value * 60.0 + f64::from(settings.limit_minutes)
            } else {
                f64::from(settings.limit_hours) * 60.0 + value
            };
            return if (1.0..=5999.0).contains(&total) {
                Ok(())
            } else {
                Err("运行时限范围为 0 小时 1 分钟至 99 小时 59 分钟".into())
            };
        }
        _ => return Ok(()),
    };
    let value = command.value;
    if !value.is_finite() || value < min || value > max {
        return Err(format!(
            "{label}范围为 {min}–{max}，请核对目标值、放电停止电压及电流和功率上限"
        ));
    }
    if (value - rounded(value, digits)).abs() > 1e-8 {
        return Err(format!("{label}输入精度为 {}", 10_f64.powi(-digits)));
    }
    Ok(())
}
