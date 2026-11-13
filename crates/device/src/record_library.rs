//! Metadata-only catalog of CSV files explicitly imported or exported by the user.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

pub const MAX_BYTES: u64 = 50_000_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingInfo {
    pub id: String,
    pub path: String,
    pub name: String,
    pub bytes: u64,
    pub modified_at: u64,
}

/// Callers serialize access. CSV contents are never written into this catalog.
pub struct Library {
    index: PathBuf,
}

impl Library {
    pub fn new(index: PathBuf) -> Self {
        Self { index }
    }

    pub fn list(&self) -> Result<Vec<RecordingInfo>, String> {
        let bytes = match fs::read(&self.index) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("无法读取记录库：{e}")),
        };
        serde_json::from_slice(&bytes).map_err(|e| format!("记录库索引无效：{e}"))
    }

    pub fn find(&self, id: &str) -> Result<RecordingInfo, String> {
        self.list()?
            .into_iter()
            .find(|entry| entry.id == id)
            .ok_or_else(|| "此记录已移出记录库".into())
    }

    pub fn register(&self, mut entry: RecordingInfo) -> Result<RecordingInfo, String> {
        if entry.path.is_empty() || entry.name.is_empty() || entry.bytes > MAX_BYTES {
            return Err("CSV 文件引用无效".into());
        }
        let mut entries = self.list()?;
        // The native picker supplies a canonical path or a persistent Android URI.
        entry.id = entry.path.clone();
        entries.retain(|old| old.id != entry.id);
        entries.insert(0, entry.clone());
        self.write(&entries)?;
        Ok(entry)
    }

    pub fn remove(&self, ids: &[String]) -> Result<(), String> {
        let mut entries = self.list()?;
        entries.retain(|entry| !ids.contains(&entry.id));
        self.write(&entries)
    }

    fn write(&self, entries: &[RecordingInfo]) -> Result<(), String> {
        if let Some(parent) = self.index.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let temporary = self.index.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(entries).map_err(|e| e.to_string())?;
        fs::write(&temporary, bytes).map_err(|e| format!("无法保存记录库：{e}"))?;
        fs::rename(&temporary, &self.index).map_err(|e| format!("无法更新记录库：{e}"))
    }
}

/// Read the whole selected file, never a prefix or the live-history cache.
pub fn read_file(path: &Path) -> Result<(RecordingInfo, Vec<u8>), String> {
    let path = fs::canonicalize(path).map_err(|e| format!("无法打开 CSV：{e}"))?;
    if !path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("csv"))
    {
        return Err("请选择 CSV 文件".into());
    }
    let mut file = fs::File::open(&path).map_err(|e| format!("无法读取 CSV：{e}"))?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("请选择普通 CSV 文件".into());
    }
    if metadata.len() > MAX_BYTES {
        return Err("此 CSV 超过 50 MB，请分段导入".into());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("此 CSV 超过 50 MB".into());
    }
    let entry = RecordingInfo {
        id: path.to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        bytes: bytes.len() as u64,
        modified_at: metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|t| t.as_millis() as u64)
            .unwrap_or(0),
    };
    Ok((entry, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn workspace(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "atorch_catalog_{name}_{}_{}",
            std::process::id(),
            crate::now_ms()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn catalog_only_lists_explicit_references_and_deletion_preserves_files() {
        let dir = workspace("references");
        let library = Library::new(dir.join("config/library.json"));
        let path = dir.join("手动 导入.csv");
        let csv = format!("DATE,VOLTAGE(V),CURRENT(A)\n{}", "1,12,1\n".repeat(8001));
        fs::write(&path, &csv).unwrap();
        fs::write(dir.join("automatic.csv"), "not registered").unwrap();
        assert!(library.list().unwrap().is_empty());
        let (entry, bytes) = read_file(&path).unwrap();
        assert_eq!(bytes, csv.as_bytes());
        let saved = library.register(entry.clone()).unwrap();
        library.register(entry).unwrap();
        let reopened = Library::new(dir.join("config/library.json"));
        assert_eq!(reopened.list().unwrap(), vec![saved.clone()]);
        let manifest = fs::read_to_string(dir.join("config/library.json")).unwrap();
        assert!(!manifest.contains("VOLTAGE"));
        reopened.remove(&[saved.id]).unwrap();
        assert!(reopened.list().unwrap().is_empty());
        assert_eq!(fs::read(&path).unwrap(), csv.as_bytes());
        assert!(dir.join("automatic.csv").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn identical_names_in_different_folders_remain_separate() {
        let dir = workspace("identities");
        let library = Library::new(dir.join("library.json"));
        for path in ["content://provider/a.csv", "content://provider/other/a.csv"] {
            library
                .register(RecordingInfo {
                    id: String::new(),
                    path: path.into(),
                    name: "a.csv".into(),
                    bytes: 123,
                    modified_at: 0,
                })
                .unwrap();
        }
        let entries = library.list().unwrap();
        assert_eq!(entries.len(), 2);
        library.remove(&[entries[0].id.clone()]).unwrap();
        assert_eq!(library.list().unwrap(), vec![entries[1].clone()]);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_oversized_files_and_preserves_an_invalid_index() {
        let dir = workspace("limits");
        let path = dir.join("large.csv");
        fs::File::create(&path)
            .unwrap()
            .set_len(MAX_BYTES + 1)
            .unwrap();
        assert!(read_file(&path).unwrap_err().contains("50 MB"));
        let index = dir.join("library.json");
        fs::write(&index, "broken").unwrap();
        assert!(Library::new(index.clone()).remove(&[]).is_err());
        assert_eq!(fs::read_to_string(&index).unwrap(), "broken");
        fs::remove_dir_all(dir).unwrap();
    }
}
