//! Access to completed local CSV recordings, independent of the live ring buffer.
use serde::Serialize;
use std::{fs, io::Read, path::Path, time::UNIX_EPOCH};

const MAX_BYTES: u64 = 50_000_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingInfo {
    pub name: String,
    pub bytes: u64,
    pub modified_at: u64,
    pub active: bool,
}

pub fn valid_filename(name: &str, extension: &str) -> bool {
    !name.starts_with('.')
        && name.len() <= 120
        && name.ends_with(extension)
        && name.len() > extension.len()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

pub fn list(directory: &Path, active: Option<&str>) -> Result<Vec<RecordingInfo>, String> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("无法读取记录目录：{e}")),
    };
    let mut result = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !valid_filename(&name, ".csv") {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            continue;
        }
        result.push(RecordingInfo {
            name,
            bytes: metadata.len(),
            modified_at: metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|t| t.as_millis() as u64)
                .unwrap_or(0),
            active: active.is_some_and(|p| Path::new(p) == entry.path()),
        });
    }
    result.sort_by(|a, b| b.modified_at.cmp(&a.modified_at).then(a.name.cmp(&b.name)));
    Ok(result)
}

pub fn read(directory: &Path, name: &str, active: Option<&str>) -> Result<String, String> {
    if !valid_filename(name, ".csv") {
        return Err("记录文件名无效，请从本机记录中选择".into());
    }
    let path = directory.join(name);
    if active.is_some_and(|p| Path::new(p) == path) {
        return Err("请先停止此文件的记录，再打开完整文件".into());
    }
    let metadata = fs::symlink_metadata(&path).map_err(|e| format!("无法读取记录：{e}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("请选择本机记录目录中的普通 CSV 文件".into());
    }
    if metadata.len() > MAX_BYTES {
        return Err("此记录超过 50 MB，请在电脑上分段查看；完整文件仍保存在记录目录".into());
    }
    let mut content = String::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(MAX_BYTES + 1)
        .read_to_string(&mut content)
        .map_err(|e| format!("记录不是有效的 UTF-8 CSV：{e}"))?;
    if content.len() as u64 > MAX_BYTES {
        return Err("此记录超过 50 MB".into());
    }
    Ok(content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_reads_full_csv_after_the_live_cache_is_gone() {
        let dir = std::env::temp_dir().join(format!(
            "atorch_archive_{}_{}",
            std::process::id(),
            crate::now_ms()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("BW150_123.csv");
        let contents = format!("DATE,VOLTAGE(V),CURRENT(A)\n{}", "1,12,1\n".repeat(8000));
        fs::write(&path, &contents).unwrap();
        fs::write(dir.join("unrelated.png"), "ignored").unwrap();
        fs::create_dir(dir.join("directory.csv")).unwrap();
        let active = path.to_str();
        let files = list(&dir, active).unwrap();
        assert_eq!(files.len(), 1);
        assert!(files[0].active);
        assert_eq!(files[0].bytes, contents.len() as u64);
        assert!(read(&dir, "BW150_123.csv", active)
            .unwrap_err()
            .contains("停止"));
        assert_eq!(read(&dir, "BW150_123.csv", None).unwrap(), contents);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_paths_and_oversized_records() {
        for name in [
            "../secret.csv",
            "D:secret.csv",
            "a/b.csv",
            "a\\b.csv",
            ".csv",
            "x.png",
        ] {
            assert!(!valid_filename(name, ".csv"), "{name}");
        }
        let dir = std::env::temp_dir().join(format!(
            "atorch_archive_limits_{}_{}",
            std::process::id(),
            crate::now_ms()
        ));
        fs::create_dir_all(&dir).unwrap();
        fs::File::create(dir.join("large.csv"))
            .unwrap()
            .set_len(MAX_BYTES + 1)
            .unwrap();
        assert!(read(&dir, "large.csv", None).unwrap_err().contains("50 MB"));
        assert!(read(&dir, "../secret.csv", None).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
