use std::{
    path::Path,
    time::{Duration, Instant},
};

pub const DEFAULT_USB_HZ: u8 = 1;

pub fn valid_usb_rate(hz: u8) -> bool {
    matches!(hz, 1 | 2 | 5)
}

pub(crate) fn read_usb_rate(path: &Path) -> u8 {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| value["usbSampleRateHz"].as_u64())
        .and_then(|hz| u8::try_from(hz).ok())
        // Retire the old 10 Hz preference until independent updates are verified.
        .map(|hz| if hz == 10 { 5 } else { hz })
        .filter(|hz| valid_usb_rate(*hz))
        .unwrap_or(DEFAULT_USB_HZ)
}

pub(crate) fn save_usb_rate(path: &Path, hz: u8) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("采样设置保存失败：{e}"))?;
    }
    let bytes = serde_json::to_vec(&serde_json::json!({ "usbSampleRateHz": hz }))
        .map_err(|e| e.to_string())?;
    std::fs::write(path, bytes).map_err(|e| format!("采样设置保存失败：{e}"))
}

/// Monotonic collection time starts at the first accepted sample. Pauses and
/// disconnected time never enter the timeline, regardless of wall-clock changes.
#[derive(Debug, Clone, Default)]
pub(crate) struct SampleClock {
    elapsed: Duration,
    running_since: Option<Instant>,
    started: bool,
    segment_id: u64,
}

impl SampleClock {
    pub fn elapsed_ms(&self, now: Instant) -> u64 {
        (self.elapsed
            + self
                .running_since
                .map_or(Duration::ZERO, |start| now.saturating_duration_since(start)))
        .as_millis() as u64
    }

    pub fn sample(&mut self, now: Instant) -> u64 {
        if !self.started {
            self.started = true;
            self.running_since = Some(now);
        }
        self.elapsed_ms(now)
    }

    pub fn pause(&mut self, now: Instant) {
        if let Some(start) = self.running_since.take() {
            self.elapsed += now.saturating_duration_since(start);
            self.segment_id += 1;
        }
    }

    pub fn segment_id(&self) -> u64 {
        self.segment_id
    }

    pub fn resume(&mut self, now: Instant) {
        if self.started && self.running_since.is_none() {
            self.running_since = Some(now);
        }
    }
}

/// Independent deadlines keep slow parameter reads from consuming telemetry slots.
/// Missed deadlines advance to the next slot without a burst of catch-up queries.
pub(crate) struct UsbSchedule {
    hz: u8,
    data_due: Instant,
    settings_due: Instant,
}

impl UsbSchedule {
    pub fn new(now: Instant, hz: u8) -> Self {
        Self {
            hz,
            data_due: now + Duration::from_millis(50),
            settings_due: now,
        }
    }

    pub fn set_rate(&mut self, now: Instant, hz: u8) {
        if hz != self.hz {
            self.hz = hz;
            self.data_due = now;
        }
    }

    pub fn refresh(&mut self, now: Instant) {
        self.data_due = now;
        self.settings_due = now;
    }

    pub fn due_queries(&mut self, now: Instant) -> Vec<u8> {
        let mut queries = Vec::with_capacity(2);
        for (kind, due, period) in [
            (3, &mut self.settings_due, Duration::from_secs(1)),
            (
                5,
                &mut self.data_due,
                Duration::from_millis(1000 / u64::from(self.hz)),
            ),
        ] {
            if now >= *due {
                queries.push(kind);
                while *due <= now {
                    *due += period;
                }
            }
        }
        queries
    }

    pub fn timeout_ms(&self, now: Instant) -> i32 {
        self.data_due
            .min(self.settings_due)
            .saturating_duration_since(now)
            .as_millis()
            .clamp(1, 80) as i32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn telemetry_slots_match_each_rate_and_parameters_remain_one_hz() {
        for hz in [1, 2, 5] {
            let start = Instant::now();
            let mut schedule = UsbSchedule::new(start, hz);
            let (mut settings, mut data) = (0, 0);
            for ms in 0..10_000 {
                for query in schedule.due_queries(start + Duration::from_millis(ms)) {
                    match query {
                        3 => settings += 1,
                        5 => data += 1,
                        _ => panic!("Only read queries are allowed"),
                    }
                }
            }
            assert_eq!(data, usize::from(hz) * 10);
            assert_eq!(settings, 10);
        }
    }

    #[test]
    fn delays_do_not_burst_and_rate_changes_update_the_read_deadline() {
        let start = Instant::now();
        let mut schedule = UsbSchedule::new(start, 2);
        assert_eq!(schedule.due_queries(start), [3]);
        assert_eq!(schedule.timeout_ms(start), 50);
        let late = start + Duration::from_secs(5);
        assert_eq!(schedule.due_queries(late), [3, 5]);
        assert!(schedule.due_queries(late).is_empty());
        schedule.set_rate(late, 5);
        assert_eq!(schedule.due_queries(late), [5]);
        assert_eq!(schedule.timeout_ms(late), 80);
        assert_eq!(schedule.timeout_ms(late + Duration::from_millis(190)), 10);
        schedule.refresh(late);
        assert_eq!(schedule.due_queries(late), [3, 5]);
        assert!(valid_usb_rate(DEFAULT_USB_HZ));
        assert!(!valid_usb_rate(0));
        assert!(!valid_usb_rate(10));
        assert!(!valid_usb_rate(255));
    }

    #[test]
    fn elapsed_clock_excludes_pauses_and_restarts_at_zero_after_clear() {
        let start = Instant::now();
        let mut clock = SampleClock::default();
        clock.resume(start);
        assert_eq!(clock.elapsed_ms(start + Duration::from_secs(30)), 0);
        assert_eq!(clock.sample(start + Duration::from_secs(30)), 0);
        clock.pause(start + Duration::from_millis(31_234));
        clock.pause(start + Duration::from_secs(40));
        assert_eq!(clock.elapsed_ms(start + Duration::from_secs(60)), 1234);
        clock.resume(start + Duration::from_secs(60));
        clock.resume(start + Duration::from_secs(61));
        assert_eq!(clock.sample(start + Duration::from_millis(62_345)), 3579);
        clock = SampleClock::default();
        clock.pause(start + Duration::from_secs(70));
        clock.resume(start + Duration::from_secs(90));
        assert_eq!(clock.sample(start + Duration::from_secs(100)), 0);
        assert_eq!(clock.elapsed_ms(start + Duration::from_secs(101)), 1000);
    }
}
