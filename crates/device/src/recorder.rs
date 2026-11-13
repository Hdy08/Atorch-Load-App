use super::{csv_row, log, now_ms, Snapshot, Telemetry, HEADER};
use std::{
    fs::{File, OpenOptions},
    io::{BufWriter, Write},
    path::PathBuf,
    time::Instant,
};

pub(crate) struct Recorder {
    directory: PathBuf,
    writer: Option<BufWriter<File>>,
    automatic: bool,
    failed: bool,
}

impl Recorder {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            writer: None,
            automatic: true,
            failed: false,
        }
    }

    fn open(&mut self, path: Option<PathBuf>, state: &mut Snapshot) -> Result<(), String> {
        let path = match path.filter(|p| !p.as_os_str().is_empty()) {
            Some(path) => path,
            None => {
                std::fs::create_dir_all(&self.directory).map_err(|e| e.to_string())?;
                let base = now_ms();
                (0..1000)
                    .map(|n| self.directory.join(format!("BW150_{base}_{n}.csv")))
                    .find(|p| !p.exists())
                    .ok_or("无法生成记录文件名")?
            }
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        let mut writer = BufWriter::new(file);
        let header = if self.automatic {
            format!("{},ELAPSED_MS,SEGMENT_ID\n", HEADER.trim_end())
        } else {
            HEADER.into()
        };
        writer
            .write_all(format!("\u{feff}{header}").as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|e| e.to_string())?;
        self.writer = Some(writer);
        state.recording = Some(path.to_string_lossy().into());
        state.recording_error = None;
        Ok(())
    }

    pub fn manual(&mut self, path: Option<PathBuf>, state: &mut Snapshot) -> Result<(), String> {
        self.flush()?;
        self.writer = None;
        self.automatic = false;
        self.failed = false;
        state.recording = None;
        state.recording_paused = false;
        if let Some(path) = path {
            self.open(Some(path), state)?;
        }
        Ok(())
    }

    pub fn sample(&mut self, telemetry: &Telemetry, state: &mut Snapshot) {
        let paused = state.sampling_paused;
        state.recording_paused = state.recording.is_some() && paused;
        if paused {
            self.failed = false;
            state.recording_clock.pause(Instant::now());
            return;
        }
        if self.failed {
            return;
        }
        let result = (|| {
            // BLE has no verified running flag: its recorder follows sampling.
            if self.automatic && self.writer.is_none() {
                self.open(None, state)?;
            }
            state.recording_clock.resume(Instant::now());
            let elapsed = state.recording_clock.sample(Instant::now());
            if let Some(file) = &mut self.writer {
                let row = if self.automatic {
                    format!(
                        "{},{elapsed},{}\n",
                        csv_row(telemetry).trim_end(),
                        state.recording_clock.segment_id()
                    )
                } else {
                    csv_row(telemetry)
                };
                file.write_all(row.as_bytes())
                    .and_then(|_| file.flush())
                    .map_err(|e| e.to_string())?;
            }
            Ok::<_, String>(())
        })();
        if let Err(error) = result {
            self.writer = None;
            self.failed = true;
            state.recording = None;
            state.recording_paused = false;
            let message = format!("记录写入失败：{error}");
            state.recording_error = Some(message.clone());
            log(state, "error", &message);
        }
    }

    pub fn finish_automatic(&mut self, state: &mut Snapshot) -> Result<(), String> {
        if self.automatic {
            self.flush()?;
            self.writer = None;
            self.failed = false;
            state.recording = None;
            state.recording_paused = false;
            state.recording_error = None;
            state.recording_clock = Default::default();
        }
        Ok(())
    }

    pub fn flush(&mut self) -> Result<(), String> {
        if let Some(file) = &mut self.writer {
            file.flush().map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}
