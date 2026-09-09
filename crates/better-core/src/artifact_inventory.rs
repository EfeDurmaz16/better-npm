//! Completeness metadata for accidental deletion and interrupted-cache recovery.
//! This is not a content-integrity proof against a writer controlling the cache.
use std::{collections::BTreeMap, fs, path::{Path, PathBuf}};
use serde::{Deserialize, Serialize};

pub const INVENTORY_FILE: &str = ".better_inventory.json";
const MAX_INVENTORY_BYTES: u64 = 16 * 1024 * 1024;
const MAX_INVENTORY_ENTRIES: usize = 100_000;

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind")]
enum Entry {
    File { size: u64 },
    Directory,
    Symlink { target: PathBuf },
}

fn inventory(root: &Path) -> Result<BTreeMap<PathBuf, Entry>, String> {
    let mut entries = BTreeMap::new();
    let mut pending = vec![PathBuf::new()];
    while let Some(relative) = pending.pop() {
        for item in fs::read_dir(root.join(&relative)).map_err(|e| e.to_string())? {
            let item = item.map_err(|e| e.to_string())?;
            let name = item.file_name();
            if relative.as_os_str().is_empty() && (name == INVENTORY_FILE || name == ".better_extracted") { continue; }
            let path = relative.join(name);
            let metadata = fs::symlink_metadata(root.join(&path)).map_err(|e| e.to_string())?;
            let kind = metadata.file_type();
            let entry = if kind.is_symlink() {
                Entry::Symlink { target: fs::read_link(root.join(&path)).map_err(|e| e.to_string())? }
            } else if kind.is_dir() {
                pending.push(path.clone()); Entry::Directory
            } else if kind.is_file() {
                Entry::File { size: metadata.len() }
            } else { return Err("Unsupported cache entry type".into()); };
            entries.insert(path, entry);
            if entries.len() > MAX_INVENTORY_ENTRIES { return Err("Package inventory exceeds 100000 entries".into()); }
        }
    }
    Ok(entries)
}

pub fn write(root: &Path) -> Result<(), String> {
    use std::io::Write;
    let target = root.join(INVENTORY_FILE);
    if fs::symlink_metadata(&target).is_ok() { return Err("Archive contains reserved inventory file".into()); }
    let entries = inventory(root)?;
    let bytes = serde_json::to_vec(&entries).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_INVENTORY_BYTES { return Err("Package inventory exceeds 16 MiB".into()); }
    let mut file = fs::File::create_new(target).map_err(|e| e.to_string())?;
    file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|e| e.to_string())
}

pub fn complete(root: &Path) -> bool {
    let path = root.join(INVENTORY_FILE);
    let Ok(metadata) = fs::symlink_metadata(&path) else { return false; };
    if !metadata.is_file() || metadata.len() > MAX_INVENTORY_BYTES { return false; }
    use std::io::Read;
    let Ok(file) = fs::File::open(path) else { return false; };
    let mut bytes = Vec::new();
    if file.take(MAX_INVENTORY_BYTES + 1).read_to_end(&mut bytes).is_err()
        || bytes.len() as u64 > MAX_INVENTORY_BYTES { return false; }
    let Ok(expected) = serde_json::from_slice::<BTreeMap<PathBuf, Entry>>(&bytes) else { return false; };
    if expected.len() > MAX_INVENTORY_ENTRIES { return false; }
    inventory(root).is_ok_and(|actual| actual == expected)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detects_missing_added_and_resized_entries() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("package")).unwrap();
        let file = root.path().join("package/index.js");
        fs::write(&file, "hello").unwrap(); write(root.path()).unwrap();
        assert!(complete(root.path()));
        fs::write(&file, "changed size").unwrap(); assert!(!complete(root.path()));
        fs::write(&file, "hello").unwrap(); assert!(complete(root.path()));
        fs::remove_file(file).unwrap(); assert!(!complete(root.path()));
    }
}
