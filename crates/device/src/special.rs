use atorch_protocol::{
    special::{reading, SpecialReading},
    Telemetry,
};
use serde::Serialize;
use std::collections::VecDeque;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpecialTest {
    pub reading: SpecialReading,
    pub started_at: Option<u64>,
    pub observed_start: bool,
    pub peak_power: Option<f64>,
    pub peak_current: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpecialResult {
    pub mode: u8,
    pub started_at: Option<u64>,
    pub stopped_at: u64,
    pub observed_start: bool,
    pub peak_power: Option<f64>,
    pub peak_current: Option<f64>,
    pub last_running: SpecialReading,
    pub stopped: SpecialReading,
}

pub fn observe(
    mode: u8,
    t: &Telemetry,
    active: &mut Option<SpecialTest>,
    results: &mut VecDeque<SpecialResult>,
) {
    let Some(next) = reading(mode, t) else {
        *active = None;
        return;
    };
    if active.as_ref().is_some_and(|v| v.reading.mode != mode) {
        *active = None;
    }
    if let Some(previous) = active {
        let starting = previous.reading.running == Some(false) && next.running == Some(true);
        let stopping = previous.reading.running == Some(true) && next.running == Some(false);
        if starting {
            previous.started_at = Some(next.timestamp);
            previous.observed_start = true;
            previous.peak_power = None;
            previous.peak_current = None;
        }
        if stopping {
            results.push_back(SpecialResult {
                mode,
                started_at: previous.started_at,
                stopped_at: next.timestamp,
                observed_start: previous.observed_start,
                peak_power: previous.peak_power,
                peak_current: previous.peak_current,
                last_running: previous.reading.clone(),
                stopped: next.clone(),
            });
            while results.len() > 100 {
                results.pop_front();
            }
        }
        if next.running == Some(true) {
            previous.peak_power = Some(
                previous
                    .peak_power
                    .map_or(next.power, |v| v.max(next.power)),
            );
            previous.peak_current = Some(
                previous
                    .peak_current
                    .map_or(next.current.abs(), |v| v.max(next.current.abs())),
            );
        }
        previous.reading = next;
    } else {
        let running = next.running == Some(true);
        *active = Some(SpecialTest {
            started_at: None,
            observed_start: false,
            peak_power: running.then_some(next.power),
            peak_current: running.then_some(next.current.abs()),
            reading: next,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn observed_sessions_keep_device_stop_separate_from_last_running_and_peaks() {
        let mut active = None;
        let mut results = VecDeque::new();
        let mut t = Telemetry {
            running: Some(false),
            stage_code: Some(0),
            timestamp: 1,
            ..Default::default()
        };
        observe(4, &t, &mut active, &mut results);
        t.running = Some(true);
        t.timestamp = 2;
        t.power = 12.0;
        t.current = -2.0;
        t.resistance = Some(0.05);
        observe(4, &t, &mut active, &mut results);
        t.timestamp = 3;
        t.power = 10.0;
        t.resistance = Some(0.04);
        observe(4, &t, &mut active, &mut results);
        t.timestamp = 4;
        t.running = Some(false);
        t.power = 0.0;
        t.resistance = Some(0.0);
        observe(4, &t, &mut active, &mut results);
        observe(4, &t, &mut active, &mut results);
        assert_eq!(results.len(), 1);
        let r = &results[0];
        assert_eq!(r.started_at, Some(2));
        assert!(r.observed_start);
        assert_eq!((r.peak_power, r.peak_current), (Some(12.0), Some(2.0)));
        assert_eq!(
            (r.last_running.resistance, r.stopped.resistance),
            (Some(0.04), Some(0.0))
        );
        observe(5, &t, &mut active, &mut results);
        assert_eq!(results.len(), 1);
        assert_eq!(active.as_ref().unwrap().reading.mode, 5);
    }
    #[test]
    fn connecting_mid_test_and_changing_modes_cannot_invent_a_complete_start() {
        let mut active = None;
        let mut results = VecDeque::new();
        let mut t = Telemetry {
            running: Some(true),
            stage_code: Some(0),
            ..Default::default()
        };
        observe(7, &t, &mut active, &mut results);
        t.running = Some(false);
        observe(7, &t, &mut active, &mut results);
        assert!(!results[0].observed_start);
        assert!(results[0].started_at.is_none());
        t.running = Some(true);
        observe(4, &t, &mut active, &mut results);
        t.running = Some(false);
        observe(5, &t, &mut active, &mut results);
        assert_eq!(results.len(), 1);
    }
}
