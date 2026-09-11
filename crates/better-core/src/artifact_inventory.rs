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

struct MetadataBudget { remaining: usize }
impl MetadataBudget {
    fn charge(&mut self, bytes: usize) -> Result<(), String> {
        self.remaining = self.remaining.checked_sub(bytes)
            .ok_or("Package inventory metadata budget exceeded")?;
        Ok(())
    }
}

fn inventory(root: &Path) -> Result<BTreeMap<PathBuf, Entry>, String> {
    inventory_with_budget(root, MAX_INVENTORY_BYTES as usize, MAX_INVENTORY_ENTRIES)
}

fn inventory_with_budget(root: &Path, bytes: usize, max_entries: usize) -> Result<BTreeMap<PathBuf, Entry>, String> {
    let mut entries = BTreeMap::new();
    visit_inventory(root, bytes, max_entries, |path, entry| { entries.insert(path, entry); Ok(()) })?;
    Ok(entries)
}

fn visit_inventory(root: &Path, bytes: usize, max_entries: usize, mut visit: impl FnMut(PathBuf, Entry) -> Result<(), String>) -> Result<usize, String> {
    let mut budget = MetadataBudget { remaining: bytes };
    let mut count = 0;
    let mut pending = vec![PathBuf::new()];
    while let Some(relative) = pending.pop() {
        for item in fs::read_dir(root.join(&relative)).map_err(|e| e.to_string())? {
            let item = item.map_err(|e| e.to_string())?;
            let name = item.file_name();
            if relative.as_os_str().is_empty() && (name == INVENTORY_FILE || name == ".better_extracted") { continue; }
            if count == max_entries { return Err("Package inventory entry budget exceeded".into()); }
            let path = relative.join(name);
            budget.charge(path.as_os_str().as_encoded_bytes().len())?;
            let metadata = fs::symlink_metadata(root.join(&path)).map_err(|e| e.to_string())?;
            let kind = metadata.file_type();
            let entry = if kind.is_symlink() {
                let target = fs::read_link(root.join(&path)).map_err(|e| e.to_string())?;
                budget.charge(target.as_os_str().as_encoded_bytes().len())?;
                Entry::Symlink { target }
            } else if kind.is_dir() {
                // Count the traversal queue's copy before allocating it as well.
                budget.charge(path.as_os_str().as_encoded_bytes().len())?;
                pending.push(path.clone()); Entry::Directory
            } else if kind.is_file() {
                Entry::File { size: metadata.len() }
            } else { return Err("Unsupported cache entry type".into()); };
            visit(path, entry)?;
            count += 1;
        }
    }
    Ok(count)
}

struct LimitedWriter<W> { inner: W, remaining: usize }
impl<W: std::io::Write> std::io::Write for LimitedWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.remaining {
            return Err(std::io::Error::other("Package inventory serialized byte budget exceeded"));
        }
        let count = self.inner.write(bytes)?;
        self.remaining -= count;
        Ok(count)
    }
    fn flush(&mut self) -> std::io::Result<()> { self.inner.flush() }
}

pub fn write(root: &Path) -> Result<(), String> {
    use std::io::Write;
    let target = root.join(INVENTORY_FILE);
    if fs::symlink_metadata(&target).is_ok() { return Err("Archive contains reserved inventory file".into()); }
    let entries = inventory(root)?;
    // Apple: push content with cheap fsync(2) so the barrier below orders it ahead of the
    // marker. Linux fsync is a full flush per file (4x slower cold), so content stays
    // unflushed there, as before; environment sealing is where that durability belongs.
    #[cfg(target_vendor = "apple")]
    for (path, entry) in &entries {
        if matches!(entry, Entry::File { .. }) {
            fs::File::open(root.join(path)).and_then(|file| crate::artifact_cache::push(&file)).map_err(|e| e.to_string())?;
        }
    }
    let file = fs::File::create_new(target).map_err(|e| e.to_string())?;
    // Buffered: serde_json otherwise issues one write(2) per token.
    let mut writer = LimitedWriter { inner: std::io::BufWriter::new(file), remaining: MAX_INVENTORY_BYTES as usize };
    serde_json::to_writer(&mut writer, &entries).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    crate::artifact_cache::barrier(writer.inner.get_ref()).map_err(|e| e.to_string())
}

/// Index validated against the current filesystem, not a content digest proof.
/// A consumer must retain a cooperative artifact lease while reusing this index.
pub struct PackageInventory { entries: BTreeMap<PathBuf, Entry> }
impl PackageInventory {
    pub fn paths(&self) -> impl Iterator<Item = &Path> {
        self.entries.keys().map(PathBuf::as_path)
    }
    pub fn file_count(&self) -> usize {
        self.entries.values().filter(|entry| matches!(entry, Entry::File { .. })).count()
    }
}

pub fn validated(root: &Path) -> Option<PackageInventory> {
    let path = root.join(INVENTORY_FILE);
    let metadata = fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_INVENTORY_BYTES { return None; }
    use std::io::Read;
    let file = fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    if file.take(MAX_INVENTORY_BYTES + 1).read_to_end(&mut bytes).is_err()
        || bytes.len() as u64 > MAX_INVENTORY_BYTES { return None; }
    let expected = serde_json::from_slice::<BTreeMap<PathBuf, Entry>>(&bytes).ok()?;
    if expected.len() > MAX_INVENTORY_ENTRIES { return None; }
    drop(bytes);
    // Compare directly during traversal instead of retaining a second path tree.
    let count = visit_inventory(root, MAX_INVENTORY_BYTES as usize, MAX_INVENTORY_ENTRIES,
        |path, entry| {
            if expected.get(&path) == Some(&entry) { Ok(()) }
            else { Err("Package inventory mismatch".into()) }
        }).ok()?;
    if count != expected.len() { return None; }
    Some(PackageInventory { entries: expected })
}

pub fn complete(root: &Path) -> bool { validated(root).is_some() }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn traversal_rejects_before_retaining_paths_over_budget() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("long-filename"), "").unwrap();
        assert!(inventory_with_budget(root.path(), 4, 10).err().unwrap().contains("metadata budget"));
        assert!(inventory_with_budget(root.path(), 100, 0).err().unwrap().contains("entry budget"));
        assert_eq!(inventory_with_budget(root.path(), 100, 10).unwrap().len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn traversal_counts_symlink_targets_and_queued_directories() {
        let root = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink("long-target", root.path().join("a")).unwrap();
        assert!(inventory_with_budget(root.path(), 4, 10).is_err());
        fs::remove_file(root.path().join("a")).unwrap();
        fs::create_dir(root.path().join("abc")).unwrap();
        assert!(inventory_with_budget(root.path(), 4, 10).is_err());
        assert!(inventory_with_budget(root.path(), 6, 10).is_ok());
    }

    #[test]
    fn serialization_never_writes_beyond_its_budget() {
        let mut writer = LimitedWriter { inner: Vec::new(), remaining: 8 };
        assert!(serde_json::to_writer(&mut writer, &"a long string").is_err());
        assert!(writer.inner.len() <= 8);
        let mut writer = LimitedWriter { inner: Vec::new(), remaining: 8 };
        serde_json::to_writer(&mut writer, &"ok").unwrap();
        assert_eq!(writer.inner, br#""ok""#);
    }

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
