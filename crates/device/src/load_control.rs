//! Application limits for the BW150 load controls, checked against fresh settings.
use atorch_protocol::{Command, DeviceSettings};

pub fn requires_settings(kind: &str) -> bool {
    matches!(
        kind,
        "target" | "cutoffVoltage" | "overCurrent" | "overPower" | "limitHours" | "limitMinutes"
    )
}

fn rounded(value: f64, digits: i32) -> f64 {
    let scale = 10_f64.powi(digits);
    (value * scale).round() / scale
}

pub fn validate(command: &Command, settings: &DeviceSettings) -> Result<(), String> {
    let target = settings.target.unwrap_or(0.0);
    let (label, min, max, digits) = match command.kind.as_str() {
        "target" => match settings.mode {
            0 => (
                "目标电流",
                0.0,
                rounded(settings.over_current, 3).min(20.0),
                3,
            ),
            1 => ("目标电压", rounded(settings.cutoff_voltage, 2), 100.0, 2),
            2 => ("目标电阻", 0.01, 9999.99, 2),
            3 => (
                "目标功率",
                0.0,
                rounded(settings.over_power, 1).min(400.0),
                1,
            ),
            _ => return Ok(()),
        },
        "cutoffVoltage" => (
            "截止电压",
            0.0,
            if settings.mode == 1 {
                rounded(target, 2).min(100.0)
            } else {
                100.0
            },
            2,
        ),
        "overCurrent" => (
            "过流保护",
            if settings.mode == 0 {
                rounded(target, 3)
            } else {
                0.0
            },
            20.0,
            3,
        ),
        "overPower" => (
            "过功率保护",
            if settings.mode == 3 {
                rounded(target, 1)
            } else {
                0.0
            },
            400.0,
            1,
        ),
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
            "{label}范围为 {min}–{max}，请核对目标值、截止电压及保护参数"
        ));
    }
    if (value - rounded(value, digits)).abs() > 1e-8 {
        return Err(format!("{label}输入精度为 {}", 10_f64.powi(-digits)));
    }
    Ok(())
}
