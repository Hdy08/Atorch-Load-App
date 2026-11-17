use atorch_protocol::Telemetry;

/// Connection-local estimates; USB telemetry always retains its device values.
#[derive(Debug, Clone, Default)]
pub(crate) struct BleMeasurements {
    energy_wh: f64,
    previous: Option<(u64, f64)>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(timestamp: u64, voltage: f64, current: f64) -> Telemetry {
        Telemetry {
            timestamp,
            voltage,
            current,
            power: voltage * current,
            ..Default::default()
        }
    }

    #[test]
    fn integrates_unrounded_power_and_derives_resistance() {
        let mut measurements = BleMeasurements::default();
        let mut last = point(0, 12.0, 0.1);
        for second in 0..=3600 {
            last = point(second * 1000, 12.0, 0.1);
            measurements.update(&mut last);
        }
        assert!((last.energy.unwrap() - 1.2).abs() < 1e-10);
        assert_eq!(last.resistance, Some(120.0));
        let mut changed = point(3_601_000, 12.0, 0.2);
        measurements.update(&mut changed);
        assert!((changed.energy.unwrap() - 1.2005).abs() < 1e-10);
        assert_eq!(changed.resistance, Some(60.0));
    }

    #[test]
    fn zero_current_is_finite_and_missing_intervals_are_not_integrated() {
        let mut measurements = BleMeasurements::default();
        let mut sample = point(1000, 5.0, 0.0);
        measurements.update(&mut sample);
        assert_eq!(sample.resistance, Some(0.0));
        assert_eq!(sample.energy, Some(0.0));
        sample = point(2000, 5.0, 0.2);
        measurements.update(&mut sample);
        let previous = sample.energy.unwrap();
        for timestamp in [50_000, 100, 9000] {
            sample = point(timestamp, 5.0, 0.2);
            measurements.update(&mut sample);
            assert_eq!(sample.energy, Some(previous));
        }
        sample = point(10_000, f64::NAN, 0.2);
        measurements.update(&mut sample);
        assert_eq!(sample.resistance, None);
        assert_eq!(sample.energy, Some(previous));
        sample = point(11_000, 5.0, 0.2);
        measurements.update(&mut sample);
        assert_eq!(sample.energy, Some(previous));
    }
}

impl BleMeasurements {
    pub fn update(&mut self, telemetry: &mut Telemetry) {
        telemetry.resistance = if telemetry.voltage.is_finite() && telemetry.current.is_finite() {
            Some(if telemetry.current.abs() > 1e-9 {
                (telemetry.voltage / telemetry.current).abs()
            } else {
                0.0
            })
        } else {
            None
        };
        if telemetry.power.is_finite() {
            let power = telemetry.power.abs();
            if let Some((timestamp, previous_power)) = self.previous {
                if let Some(interval) = telemetry.timestamp.checked_sub(timestamp) {
                    // Never invent energy for a lost connection or a clock jump.
                    if interval <= 5000 {
                        self.energy_wh +=
                            (previous_power + power) * 0.5 * interval as f64 / 3_600_000.0;
                    }
                }
            }
            self.previous = Some((telemetry.timestamp, power));
        } else {
            self.previous = None;
        }
        telemetry.energy = Some(self.energy_wh);
    }
}
