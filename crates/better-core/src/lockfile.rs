use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::types::ResolvedPackage;
use crate::JsonWriter;

// === Binary format constants ===

const MAGIC: [u8; 4] = *b"BTLK";
const FORMAT_VERSION: u16 = 1;
const FORMAT_VERSION_V2: u16 = 2;
const HEADER_SIZE: usize = 44;
/// V2 header: same 44 bytes + ecosystem_count(1) + padding(3) = 48 bytes
const HEADER_SIZE_V2: usize = 48;
/// V2 ecosystem section index entry: ecosystem_id(1) + offset(4) + count(4) = 9 bytes
const ECOSYSTEM_INDEX_ENTRY_SIZE: usize = 9;
const PACKAGE_INDEX_ENTRY_SIZE: usize = 32;

/// Ecosystem identifiers for the binary lockfile.
pub const ECOSYSTEM_NPM: u8 = 0;
pub const ECOSYSTEM_PYTHON: u8 = 1;

// === Binary lockfile structures ===

/// A package entry for the lockfile (used by both writer and reader).
#[derive(Debug, Clone)]
pub struct LockPackage {
    pub name: String,
    pub version: String,
    pub integrity: String,
    pub resolved: String,
    pub dependencies: Vec<String>, // "name@version" refs
    /// Ecosystem this package belongs to (0=npm, 1=python). Default 0.
    pub ecosystem: u8,
}

impl LockPackage {
    /// Create from a ResolvedPackage (the install engine's type).
    pub fn from_resolved(pkg: &ResolvedPackage, deps: Vec<String>) -> Self {
        Self {
            name: pkg.name.clone(),
            version: pkg.version.clone(),
            integrity: pkg.integrity.clone(),
            resolved: pkg.resolved_url.clone(),
            dependencies: deps,
            ecosystem: ECOSYSTEM_NPM,
        }
    }
}

/// Writes better.lock (binary) and better.lock.json (sidecar).
pub struct LockfileWriter {
    packages: Vec<LockPackage>,
}

impl LockfileWriter {
    pub fn new() -> Self {
        Self {
            packages: Vec::new(),
        }
    }

    pub fn add_package(&mut self, pkg: LockPackage) {
        self.packages.push(pkg);
    }

    /// Populate from resolved packages (convenience for install flow).
    pub fn from_resolved_packages(resolved: &[ResolvedPackage]) -> Self {
        let mut writer = Self::new();
        // Build a lookup: name -> version for dependency resolution
        let version_map: BTreeMap<&str, &str> = resolved
            .iter()
            .map(|p| (p.name.as_str(), p.version.as_str()))
            .collect();

        for pkg in resolved {
            // We don't have dep info in ResolvedPackage directly,
            // so dependencies are empty for now — they can be enriched later
            // from the original lockfile parse.
            let _ = &version_map; // suppress unused warning
            writer.add_package(LockPackage::from_resolved(pkg, Vec::new()));
        }
        writer
    }

    /// Write both better.lock and better.lock.json atomically.
    pub fn write_both(&self, dir: &Path) -> Result<LockfileWriteResult, String> {
        let binary_path = dir.join("better.lock");
        let json_path = dir.join("better.lock.json");

        let binary_bytes = self.build_binary()?;
        let json_string = self.build_json();

        // Write binary
        fs::write(&binary_path, &binary_bytes)
            .map_err(|e| format!("Failed to write better.lock: {}", e))?;

        // Write JSON sidecar
        fs::write(&json_path, json_string.as_bytes())
            .map_err(|e| format!("Failed to write better.lock.json: {}", e))?;

        // Compute fingerprint of the binary file
        let mut hasher = Sha256::new();
        hasher.update(&binary_bytes);
        let fingerprint = format!("sha256:{:x}", hasher.finalize());

        Ok(LockfileWriteResult {
            binary_path: binary_path.to_string_lossy().to_string(),
            json_path: json_path.to_string_lossy().to_string(),
            package_count: self.packages.len() as u32,
            binary_size: binary_bytes.len() as u64,
            fingerprint,
        })
    }

    /// Check if this lockfile has multi-ecosystem packages.
    fn is_multi_ecosystem(&self) -> bool {
        let mut seen: u8 = 0;
        for pkg in &self.packages {
            seen |= 1 << pkg.ecosystem;
            if seen.count_ones() > 1 {
                return true;
            }
        }
        self.packages.iter().any(|p| p.ecosystem != ECOSYSTEM_NPM)
    }

    /// Write v2 format: multi-ecosystem lockfile.
    ///
    /// The v2 binary format extends v1 with an ecosystem section index
    /// between the header and the package index. V1 readers will see
    /// `version = 2` and skip it gracefully.
    pub fn write_both_v2(&self, dir: &Path) -> Result<LockfileWriteResult, String> {
        let binary_path = dir.join("better.lock");
        let json_path = dir.join("better.lock.json");

        let binary_bytes = self.build_binary_v2()?;
        let json_string = self.build_json_v2();

        fs::write(&binary_path, &binary_bytes)
            .map_err(|e| format!("Failed to write better.lock: {}", e))?;
        fs::write(&json_path, json_string.as_bytes())
            .map_err(|e| format!("Failed to write better.lock.json: {}", e))?;

        let mut hasher = Sha256::new();
        hasher.update(&binary_bytes);
        let fingerprint = format!("sha256:{:x}", hasher.finalize());

        Ok(LockfileWriteResult {
            binary_path: binary_path.to_string_lossy().to_string(),
            json_path: json_path.to_string_lossy().to_string(),
            package_count: self.packages.len() as u32,
            binary_size: binary_bytes.len() as u64,
            fingerprint,
        })
    }

    /// Build the v2 binary format with ecosystem sections.
    fn build_binary_v2(&self) -> Result<Vec<u8>, String> {
        // Group packages by ecosystem, then sort within each group
        let mut by_ecosystem: BTreeMap<u8, Vec<&LockPackage>> = BTreeMap::new();
        for pkg in &self.packages {
            by_ecosystem.entry(pkg.ecosystem).or_default().push(pkg);
        }
        for pkgs in by_ecosystem.values_mut() {
            pkgs.sort_by(|a, b| a.name.cmp(&b.name));
        }

        let ecosystem_count = by_ecosystem.len() as u8;
        let total_packages: u32 = self.packages.len() as u32;

        // Build string table and per-package data (same as v1)
        let mut string_table = Vec::<u8>::new();
        let mut string_offsets: Vec<(u32, u16)> = Vec::new();

        let intern_string = |s: &str, table: &mut Vec<u8>, offsets: &mut Vec<(u32, u16)>| -> usize {
            let offset = table.len() as u32;
            let bytes = s.as_bytes();
            let len = bytes.len() as u16;
            table.extend_from_slice(&len.to_le_bytes());
            table.extend_from_slice(bytes);
            let idx = offsets.len();
            offsets.push((offset, len));
            idx
        };

        // Flatten for indexing: assign global indices in ecosystem order
        let mut all_sorted: Vec<&LockPackage> = Vec::new();
        let mut ecosystem_ranges: Vec<(u8, u32, u32)> = Vec::new(); // (id, start_idx, count)
        for (&eco_id, pkgs) in &by_ecosystem {
            let start = all_sorted.len() as u32;
            all_sorted.extend(pkgs.iter());
            ecosystem_ranges.push((eco_id, start, pkgs.len() as u32));
        }

        let name_to_index: BTreeMap<&str, u32> = all_sorted
            .iter()
            .enumerate()
            .map(|(i, p)| (p.name.as_str(), i as u32))
            .collect();

        struct PackageStrings {
            name_idx: usize,
            version_idx: usize,
            integrity_idx: usize,
            dep_indices: Vec<u32>,
        }

        let mut pkg_strings = Vec::with_capacity(all_sorted.len());
        for pkg in &all_sorted {
            let name_idx = intern_string(&pkg.name, &mut string_table, &mut string_offsets);
            let version_idx = intern_string(&pkg.version, &mut string_table, &mut string_offsets);
            let integrity_idx = intern_string(&pkg.integrity, &mut string_table, &mut string_offsets);
            let _ = intern_string(&pkg.resolved, &mut string_table, &mut string_offsets);

            let dep_indices: Vec<u32> = pkg
                .dependencies
                .iter()
                .filter_map(|dep_ref| {
                    let dep_name = if let Some(at_pos) = dep_ref.rfind('@') {
                        if at_pos > 0 { &dep_ref[..at_pos] } else { dep_ref }
                    } else {
                        dep_ref
                    };
                    name_to_index.get(dep_name).copied()
                })
                .collect();

            pkg_strings.push(PackageStrings {
                name_idx,
                version_idx,
                integrity_idx,
                dep_indices,
            });
        }

        // Build deps table
        let mut deps_table = Vec::<u8>::new();
        let mut deps_offsets: Vec<(u32, u16)> = Vec::new();

        for ps in &pkg_strings {
            let offset = (deps_table.len() / 4) as u32;
            let count = ps.dep_indices.len() as u16;
            for &idx in &ps.dep_indices {
                deps_table.extend_from_slice(&idx.to_le_bytes());
            }
            deps_offsets.push((offset, count));
        }

        // Layout: header_v2 + ecosystem_index + package_index + string_table + deps_table
        let eco_index_size = ecosystem_ranges.len() * ECOSYSTEM_INDEX_ENTRY_SIZE;
        let pkg_index_size = (total_packages as usize) * PACKAGE_INDEX_ENTRY_SIZE;
        let total_size = HEADER_SIZE_V2 + eco_index_size + pkg_index_size + string_table.len() + deps_table.len();

        let mut buf = Vec::with_capacity(total_size);

        // === Header V2 (48 bytes) ===
        buf.extend_from_slice(&MAGIC);                           // 4: magic
        buf.extend_from_slice(&FORMAT_VERSION_V2.to_le_bytes()); // 2: version = 2
        buf.extend_from_slice(&0u16.to_le_bytes());              // 2: flags
        buf.extend_from_slice(&total_packages.to_le_bytes());    // 4: package_count
        let checksum_offset = buf.len();
        buf.extend_from_slice(&[0u8; 32]);                       // 32: checksum placeholder
        buf.push(ecosystem_count);                               // 1: ecosystem_count
        buf.extend_from_slice(&[0u8; 3]);                        // 3: padding

        // === Ecosystem Section Index ===
        let pkg_index_base = HEADER_SIZE_V2 + eco_index_size;
        for &(eco_id, start_idx, count) in &ecosystem_ranges {
            buf.push(eco_id);                                           // 1: ecosystem_id
            let offset = (pkg_index_base + (start_idx as usize) * PACKAGE_INDEX_ENTRY_SIZE) as u32;
            buf.extend_from_slice(&offset.to_le_bytes());               // 4: offset
            buf.extend_from_slice(&count.to_le_bytes());                // 4: count
        }

        // === Package Index ===
        let string_table_base = (HEADER_SIZE_V2 + eco_index_size + pkg_index_size) as u32;
        let deps_table_base = string_table_base + string_table.len() as u32;

        for (i, ps) in pkg_strings.iter().enumerate() {
            let (name_off, name_len) = string_offsets[ps.name_idx];
            let (ver_off, ver_len) = string_offsets[ps.version_idx];
            let (int_off, int_len) = string_offsets[ps.integrity_idx];
            let (dep_off, deps_count) = deps_offsets[i];

            buf.extend_from_slice(&(string_table_base + name_off).to_le_bytes());
            buf.extend_from_slice(&name_len.to_le_bytes());
            buf.extend_from_slice(&(string_table_base + ver_off).to_le_bytes());
            buf.extend_from_slice(&ver_len.to_le_bytes());
            buf.extend_from_slice(&(string_table_base + int_off).to_le_bytes());
            buf.extend_from_slice(&int_len.to_le_bytes());
            buf.extend_from_slice(&(deps_table_base + dep_off * 4).to_le_bytes());
            buf.extend_from_slice(&deps_count.to_le_bytes());
            buf.extend_from_slice(&[0u8; 8]); // padding
        }

        // === String Table ===
        buf.extend_from_slice(&string_table);

        // === Deps Table ===
        buf.extend_from_slice(&deps_table);

        // === Checksum ===
        let mut hasher = Sha256::new();
        hasher.update(&buf[HEADER_SIZE_V2..]);
        let checksum: [u8; 32] = hasher.finalize().into();
        buf[checksum_offset..checksum_offset + 32].copy_from_slice(&checksum);

        Ok(buf)
    }

    /// Build the v2 JSON sidecar with ecosystem-keyed structure.
    fn build_json_v2(&self) -> String {
        // Group by ecosystem
        let mut by_ecosystem: BTreeMap<u8, Vec<&LockPackage>> = BTreeMap::new();
        for pkg in &self.packages {
            by_ecosystem.entry(pkg.ecosystem).or_default().push(pkg);
        }
        for pkgs in by_ecosystem.values_mut() {
            pkgs.sort_by(|a, b| {
                let key_a = format!("{}@{}", a.name, a.version);
                let key_b = format!("{}@{}", b.name, b.version);
                key_a.cmp(&key_b)
            });
        }

        let ecosystem_name = |id: u8| -> &str {
            match id {
                ECOSYSTEM_NPM => "npm",
                ECOSYSTEM_PYTHON => "python",
                _ => "unknown",
            }
        };

        let mut w = JsonWriter::new();
        w.begin_object();

        w.key("version");
        w.value_u64(2);

        w.key("generated");
        w.value_string(&crate::chrono_now());

        // Write each ecosystem section
        for (&eco_id, pkgs) in &by_ecosystem {
            w.key(ecosystem_name(eco_id));
            w.begin_object();
            w.key("packages");
            w.begin_object();

            for pkg in pkgs {
                let pkg_key = format!("{}@{}", pkg.name, pkg.version);
                w.key(&pkg_key);
                w.begin_object();

                w.key("version");
                w.value_string(&pkg.version);

                w.key("resolved");
                w.value_string(&pkg.resolved);

                w.key("integrity");
                w.value_string(&pkg.integrity);

                if !pkg.dependencies.is_empty() {
                    w.key("dependencies");
                    w.begin_object();
                    let mut deps_sorted = pkg.dependencies.clone();
                    deps_sorted.sort();
                    for dep_ref in &deps_sorted {
                        if let Some(at_pos) = dep_ref.rfind('@') {
                            if at_pos > 0 {
                                let dep_name = &dep_ref[..at_pos];
                                let dep_ver = &dep_ref[at_pos + 1..];
                                w.key(dep_name);
                                w.value_string(dep_ver);
                            }
                        }
                    }
                    w.end_object();
                }

                w.end_object();
            }
            w.end_object(); // packages
            w.end_object(); // ecosystem
        }

        // Fingerprint
        let mut hasher = Sha256::new();
        for pkg in &self.packages {
            hasher.update(format!("{}@{}:{}", pkg.name, pkg.version, pkg.integrity).as_bytes());
        }
        let fp = format!("sha256:{:x}", hasher.finalize());
        w.key("fingerprint");
        w.value_string(&fp);

        w.end_object();
        w.out.push('\n');
        w.finish()
    }

    /// Build the binary lockfile bytes.
    fn build_binary(&self) -> Result<Vec<u8>, String> {
        // Sort packages by name for deterministic output and binary search
        let mut sorted: Vec<&LockPackage> = self.packages.iter().collect();
        sorted.sort_by(|a, b| a.name.cmp(&b.name));

        // Build string table
        let mut string_table = Vec::<u8>::new();
        let mut string_offsets: Vec<(u32, u16)> = Vec::new(); // (offset, len) for each string

        let intern_string = |s: &str, table: &mut Vec<u8>, offsets: &mut Vec<(u32, u16)>| -> usize {
            let offset = table.len() as u32;
            let bytes = s.as_bytes();
            let len = bytes.len() as u16;
            // Write length-prefixed: u16 len + bytes
            table.extend_from_slice(&len.to_le_bytes());
            table.extend_from_slice(bytes);
            let idx = offsets.len();
            offsets.push((offset, len));
            idx
        };

        // Intern all strings: for each package, intern name, version, integrity, resolved
        struct PackageStrings {
            name_idx: usize,
            version_idx: usize,
            integrity_idx: usize,
            dep_indices: Vec<u32>, // indices into the sorted package list
        }

        let name_to_index: BTreeMap<&str, u32> = sorted
            .iter()
            .enumerate()
            .map(|(i, p)| (p.name.as_str(), i as u32))
            .collect();

        let mut pkg_strings = Vec::with_capacity(sorted.len());
        for pkg in &sorted {
            let name_idx = intern_string(&pkg.name, &mut string_table, &mut string_offsets);
            let version_idx = intern_string(&pkg.version, &mut string_table, &mut string_offsets);
            let integrity_idx = intern_string(&pkg.integrity, &mut string_table, &mut string_offsets);
            // Store resolved URL in string table (used by JSON sidecar, not binary index)
            let _ = intern_string(&pkg.resolved, &mut string_table, &mut string_offsets);

            // Resolve dependency references to package indices
            let dep_indices: Vec<u32> = pkg
                .dependencies
                .iter()
                .filter_map(|dep_ref| {
                    // dep_ref is "name@version" — extract just the name
                    let dep_name = if let Some(at_pos) = dep_ref.rfind('@') {
                        if at_pos > 0 { &dep_ref[..at_pos] } else { dep_ref }
                    } else {
                        dep_ref
                    };
                    name_to_index.get(dep_name).copied()
                })
                .collect();

            pkg_strings.push(PackageStrings {
                name_idx,
                version_idx,
                integrity_idx,
                dep_indices,
            });
        }

        // Build deps table
        let mut deps_table = Vec::<u8>::new();
        let mut deps_offsets: Vec<(u32, u16)> = Vec::new(); // (offset_in_deps_table, count)

        for ps in &pkg_strings {
            let offset = (deps_table.len() / 4) as u32;
            let count = ps.dep_indices.len() as u16;
            for &idx in &ps.dep_indices {
                deps_table.extend_from_slice(&idx.to_le_bytes());
            }
            deps_offsets.push((offset, count));
        }

        // Now build the full binary
        let package_count = sorted.len() as u32;
        let index_size = (package_count as usize) * PACKAGE_INDEX_ENTRY_SIZE;
        let total_size = HEADER_SIZE + index_size + string_table.len() + deps_table.len();

        let mut buf = Vec::with_capacity(total_size);

        // === Header (44 bytes) ===
        // magic (4)
        buf.extend_from_slice(&MAGIC);
        // version (2)
        buf.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
        // flags (2)
        buf.extend_from_slice(&0u16.to_le_bytes());
        // package_count (4)
        buf.extend_from_slice(&package_count.to_le_bytes());
        // checksum placeholder (32) — filled after everything else
        let checksum_offset = buf.len();
        buf.extend_from_slice(&[0u8; 32]);

        // === Package Index ===
        let string_table_base = (HEADER_SIZE + index_size) as u32;
        let deps_table_base = string_table_base + string_table.len() as u32;

        for (i, ps) in pkg_strings.iter().enumerate() {
            let (name_off, name_len) = string_offsets[ps.name_idx];
            let (ver_off, ver_len) = string_offsets[ps.version_idx];
            let (int_off, int_len) = string_offsets[ps.integrity_idx];
            let (deps_off, deps_count) = deps_offsets[i];

            // name_offset: u32 (absolute offset into file)
            buf.extend_from_slice(&(string_table_base + name_off).to_le_bytes());
            // name_len: u16
            buf.extend_from_slice(&name_len.to_le_bytes());
            // version_offset: u32
            buf.extend_from_slice(&(string_table_base + ver_off).to_le_bytes());
            // version_len: u16
            buf.extend_from_slice(&ver_len.to_le_bytes());
            // integrity_offset: u32
            buf.extend_from_slice(&(string_table_base + int_off).to_le_bytes());
            // integrity_len: u16
            buf.extend_from_slice(&int_len.to_le_bytes());
            // deps_offset: u32 (index into deps table, as entry count)
            buf.extend_from_slice(&(deps_table_base + deps_off * 4).to_le_bytes());
            // deps_count: u16
            buf.extend_from_slice(&deps_count.to_le_bytes());
            // _padding: [u8; 8]
            buf.extend_from_slice(&[0u8; 8]);
        }

        // === String Table ===
        buf.extend_from_slice(&string_table);

        // === Deps Table ===
        buf.extend_from_slice(&deps_table);

        // === Fill checksum: SHA-256 of everything after header ===
        let mut hasher = Sha256::new();
        hasher.update(&buf[HEADER_SIZE..]);
        let checksum: [u8; 32] = hasher.finalize().into();
        buf[checksum_offset..checksum_offset + 32].copy_from_slice(&checksum);

        Ok(buf)
    }

    /// Build the JSON sidecar string.
    fn build_json(&self) -> String {
        // Sort packages by "name@version" for deterministic output
        let mut sorted: Vec<&LockPackage> = self.packages.iter().collect();
        sorted.sort_by(|a, b| {
            let key_a = format!("{}@{}", a.name, a.version);
            let key_b = format!("{}@{}", b.name, b.version);
            key_a.cmp(&key_b)
        });

        let mut w = JsonWriter::new();
        w.begin_object();

        w.key("version");
        w.value_u64(1);

        w.key("generated");
        w.value_string(&crate::chrono_now());

        w.key("packages");
        w.begin_object();
        for pkg in &sorted {
            let pkg_key = format!("{}@{}", pkg.name, pkg.version);
            w.key(&pkg_key);
            w.begin_object();

            w.key("version");
            w.value_string(&pkg.version);

            w.key("resolved");
            w.value_string(&pkg.resolved);

            w.key("integrity");
            w.value_string(&pkg.integrity);

            if !pkg.dependencies.is_empty() {
                w.key("dependencies");
                w.begin_object();
                let mut deps_sorted = pkg.dependencies.clone();
                deps_sorted.sort();
                for dep_ref in &deps_sorted {
                    // dep_ref is "name@version" — split
                    if let Some(at_pos) = dep_ref.rfind('@') {
                        if at_pos > 0 {
                            let dep_name = &dep_ref[..at_pos];
                            let dep_ver = &dep_ref[at_pos + 1..];
                            w.key(dep_name);
                            w.value_string(dep_ver);
                        }
                    }
                }
                w.end_object();
            }

            w.end_object();
        }
        w.end_object();

        // Fingerprint of the packages section
        let packages_json = {
            let mut pw = JsonWriter::new();
            pw.begin_object();
            for pkg in &sorted {
                let pkg_key = format!("{}@{}", pkg.name, pkg.version);
                pw.key(&pkg_key);
                pw.value_string(&pkg.integrity);
            }
            pw.end_object();
            pw.finish()
        };
        let mut hasher = Sha256::new();
        hasher.update(packages_json.as_bytes());
        let fp = format!("sha256:{:x}", hasher.finalize());
        w.key("fingerprint");
        w.value_string(&fp);

        w.end_object();
        w.out.push('\n');
        w.finish()
    }
}

/// Reads a better.lock binary file (supports both v1 and v2).
pub struct LockfileReader {
    data: Vec<u8>,
    format_version: u16,
    /// Offset to the first package index entry (differs between v1 and v2).
    pkg_index_offset: usize,
}

impl LockfileReader {
    /// Load from a binary lockfile path.
    pub fn from_binary(path: &Path) -> Result<Self, String> {
        let data = fs::read(path)
            .map_err(|e| format!("Failed to read better.lock: {}", e))?;

        // Validate minimum size
        if data.len() < HEADER_SIZE {
            return Err("better.lock is too small to be valid".into());
        }

        // Validate magic
        if &data[0..4] != &MAGIC {
            return Err("better.lock has invalid magic bytes".into());
        }

        // Read version
        let version = u16::from_le_bytes([data[4], data[5]]);
        if version != FORMAT_VERSION && version != FORMAT_VERSION_V2 {
            return Err(format!(
                "better.lock version {} is not supported (expected {} or {})",
                version, FORMAT_VERSION, FORMAT_VERSION_V2
            ));
        }

        // Determine header size and checksum range
        let (header_size, pkg_index_offset) = if version == FORMAT_VERSION_V2 {
            if data.len() < HEADER_SIZE_V2 {
                return Err("better.lock v2 header too small".into());
            }
            let ecosystem_count = data[44] as usize;
            let eco_index_size = ecosystem_count * ECOSYSTEM_INDEX_ENTRY_SIZE;
            (HEADER_SIZE_V2, HEADER_SIZE_V2 + eco_index_size)
        } else {
            (HEADER_SIZE, HEADER_SIZE)
        };

        // Validate checksum
        let stored_checksum = &data[12..44];
        let mut hasher = Sha256::new();
        hasher.update(&data[header_size..]);
        let computed: [u8; 32] = hasher.finalize().into();
        if stored_checksum != &computed[..] {
            return Err("better.lock checksum mismatch — file may be corrupted".into());
        }

        Ok(Self {
            data,
            format_version: version,
            pkg_index_offset,
        })
    }

    /// Format version of this lockfile (1 or 2).
    pub fn version(&self) -> u16 {
        self.format_version
    }

    /// Number of packages in the lockfile.
    pub fn package_count(&self) -> u32 {
        u32::from_le_bytes([self.data[8], self.data[9], self.data[10], self.data[11]])
    }

    /// Number of ecosystems (v2 only, returns 1 for v1).
    pub fn ecosystem_count(&self) -> u8 {
        if self.format_version >= FORMAT_VERSION_V2 && self.data.len() >= HEADER_SIZE_V2 {
            self.data[44]
        } else {
            1
        }
    }

    /// Get ecosystem section info (v2 only).
    /// Returns vec of (ecosystem_id, offset_in_file, package_count).
    pub fn ecosystem_sections(&self) -> Vec<(u8, u32, u32)> {
        if self.format_version < FORMAT_VERSION_V2 {
            // V1: single implicit npm section
            return vec![(ECOSYSTEM_NPM, HEADER_SIZE as u32, self.package_count())];
        }

        let count = self.data[44] as usize;
        let mut sections = Vec::with_capacity(count);
        for i in 0..count {
            let base = HEADER_SIZE_V2 + i * ECOSYSTEM_INDEX_ENTRY_SIZE;
            if base + ECOSYSTEM_INDEX_ENTRY_SIZE > self.data.len() {
                break;
            }
            let eco_id = self.data[base];
            let offset = u32::from_le_bytes([
                self.data[base + 1],
                self.data[base + 2],
                self.data[base + 3],
                self.data[base + 4],
            ]);
            let pkg_count = u32::from_le_bytes([
                self.data[base + 5],
                self.data[base + 6],
                self.data[base + 7],
                self.data[base + 8],
            ]);
            sections.push((eco_id, offset, pkg_count));
        }
        sections
    }

    /// Read a package by index (O(1) access).
    pub fn get_package(&self, index: u32) -> Result<LockPackage, String> {
        let count = self.package_count();
        if index >= count {
            return Err(format!("Package index {} out of range (count={})", index, count));
        }

        let entry_offset = self.pkg_index_offset + (index as usize) * PACKAGE_INDEX_ENTRY_SIZE;
        let entry = &self.data[entry_offset..entry_offset + PACKAGE_INDEX_ENTRY_SIZE];

        let name_offset = u32::from_le_bytes([entry[0], entry[1], entry[2], entry[3]]) as usize;
        let name_len = u16::from_le_bytes([entry[4], entry[5]]) as usize;
        let version_offset = u32::from_le_bytes([entry[6], entry[7], entry[8], entry[9]]) as usize;
        let version_len = u16::from_le_bytes([entry[10], entry[11]]) as usize;
        let integrity_offset = u32::from_le_bytes([entry[12], entry[13], entry[14], entry[15]]) as usize;
        let integrity_len = u16::from_le_bytes([entry[16], entry[17]]) as usize;
        let deps_offset = u32::from_le_bytes([entry[18], entry[19], entry[20], entry[21]]) as usize;
        let deps_count = u16::from_le_bytes([entry[22], entry[23]]) as usize;

        // Read strings from the string table (length-prefixed: skip the u16 len prefix)
        let name = self.read_string(name_offset, name_len)?;
        let version = self.read_string(version_offset, version_len)?;
        let integrity = self.read_string(integrity_offset, integrity_len)?;

        // Read dependency indices
        let mut dependencies = Vec::with_capacity(deps_count);
        for i in 0..deps_count {
            let dep_byte_offset = deps_offset + i * 4;
            if dep_byte_offset + 4 > self.data.len() {
                break;
            }
            let dep_idx = u32::from_le_bytes([
                self.data[dep_byte_offset],
                self.data[dep_byte_offset + 1],
                self.data[dep_byte_offset + 2],
                self.data[dep_byte_offset + 3],
            ]);
            // Resolve dep index to "name@version"
            if let Ok(dep_pkg) = self.get_package_name_version(dep_idx) {
                dependencies.push(dep_pkg);
            }
        }

        Ok(LockPackage {
            name,
            version,
            integrity,
            resolved: String::new(), // resolved URL not stored separately in index
            dependencies,
            ecosystem: self.ecosystem_for_index(index),
        })
    }

    /// Determine which ecosystem a package index belongs to (v2 only).
    fn ecosystem_for_index(&self, index: u32) -> u8 {
        if self.format_version < FORMAT_VERSION_V2 {
            return ECOSYSTEM_NPM;
        }
        for (eco_id, _offset, count) in self.ecosystem_sections() {
            // Find which section this index falls into
            // The sections are ordered, and package indices are contiguous
            // We need to compute start_idx from offset
            let start_idx = (_offset as usize - self.pkg_index_offset) / PACKAGE_INDEX_ENTRY_SIZE;
            if (index as usize) >= start_idx && (index as usize) < start_idx + count as usize {
                return eco_id;
            }
        }
        ECOSYSTEM_NPM
    }

    /// Read just name and version for a package index (avoids recursion in dep resolution).
    fn get_package_name_version(&self, index: u32) -> Result<String, String> {
        let count = self.package_count();
        if index >= count {
            return Err("index out of range".into());
        }

        let entry_offset = self.pkg_index_offset + (index as usize) * PACKAGE_INDEX_ENTRY_SIZE;
        let entry = &self.data[entry_offset..entry_offset + PACKAGE_INDEX_ENTRY_SIZE];

        let name_offset = u32::from_le_bytes([entry[0], entry[1], entry[2], entry[3]]) as usize;
        let name_len = u16::from_le_bytes([entry[4], entry[5]]) as usize;
        let version_offset = u32::from_le_bytes([entry[6], entry[7], entry[8], entry[9]]) as usize;
        let version_len = u16::from_le_bytes([entry[10], entry[11]]) as usize;

        let name = self.read_string(name_offset, name_len)?;
        let version = self.read_string(version_offset, version_len)?;

        Ok(format!("{}@{}", name, version))
    }

    /// Read a length-prefixed string from the string table.
    /// The string table stores: u16 len + bytes. We skip the len prefix.
    fn read_string(&self, offset: usize, expected_len: usize) -> Result<String, String> {
        // offset points to the u16 length prefix
        let str_start = offset + 2; // skip the u16 len prefix
        if str_start + expected_len > self.data.len() {
            return Err(format!(
                "String at offset {} with len {} exceeds file bounds",
                offset, expected_len
            ));
        }
        String::from_utf8(self.data[str_start..str_start + expected_len].to_vec())
            .map_err(|e| format!("Invalid UTF-8 in string table: {}", e))
    }

    /// Find a package by name (binary search since packages are sorted).
    pub fn find_package(&self, name: &str) -> Option<LockPackage> {
        let count = self.package_count();
        if count == 0 {
            return None;
        }

        // Binary search over the sorted package index
        let mut lo = 0u32;
        let mut hi = count;

        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            let entry_offset = self.pkg_index_offset + (mid as usize) * PACKAGE_INDEX_ENTRY_SIZE;
            let entry = &self.data[entry_offset..entry_offset + PACKAGE_INDEX_ENTRY_SIZE];

            let name_offset = u32::from_le_bytes([entry[0], entry[1], entry[2], entry[3]]) as usize;
            let name_len = u16::from_le_bytes([entry[4], entry[5]]) as usize;

            if let Ok(pkg_name) = self.read_string(name_offset, name_len) {
                match pkg_name.as_str().cmp(name) {
                    std::cmp::Ordering::Equal => return self.get_package(mid).ok(),
                    std::cmp::Ordering::Less => lo = mid + 1,
                    std::cmp::Ordering::Greater => hi = mid,
                }
            } else {
                break;
            }
        }

        None
    }

    /// Get the SHA-256 fingerprint of the binary data.
    pub fn fingerprint(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(&self.data);
        format!("sha256:{:x}", hasher.finalize())
    }
}

/// Check if a better.lock exists and would change with the given packages.
/// Returns Ok(true) if lockfile matches, Ok(false) if it would change.
pub fn verify_frozen_lockfile(
    dir: &Path,
    resolved: &[ResolvedPackage],
) -> Result<bool, String> {
    let lock_path = dir.join("better.lock");
    if !lock_path.exists() {
        return Err("--frozen: better.lock does not exist".into());
    }

    let reader = LockfileReader::from_binary(&lock_path)?;
    let existing_count = reader.package_count();

    if existing_count != resolved.len() as u32 {
        return Ok(false);
    }

    // Check each resolved package exists in the lockfile with matching integrity
    for pkg in resolved {
        match reader.find_package(&pkg.name) {
            Some(lock_pkg) => {
                if lock_pkg.version != pkg.version || lock_pkg.integrity != pkg.integrity {
                    return Ok(false);
                }
            }
            None => return Ok(false),
        }
    }

    Ok(true)
}

/// Result of writing lockfiles.
#[derive(Debug)]
pub struct LockfileWriteResult {
    pub binary_path: String,
    pub json_path: String,
    pub package_count: u32,
    pub binary_size: u64,
    pub fingerprint: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_roundtrip() {
        let mut writer = LockfileWriter::new();

        writer.add_package(LockPackage {
            name: "lodash".into(),
            version: "4.17.21".into(),
            integrity: "sha512-WjKPNJF79dkKgZbkHhiapMFzg4+XL6EHi+m17GgFzRR3hvJeA==".into(),
            resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz".into(),
            dependencies: vec![],
            ecosystem: ECOSYSTEM_NPM,
        });

        writer.add_package(LockPackage {
            name: "express".into(),
            version: "4.18.2".into(),
            integrity: "sha512-abc123==".into(),
            resolved: "https://registry.npmjs.org/express/-/express-4.18.2.tgz".into(),
            dependencies: vec!["lodash@4.17.21".into()],
            ecosystem: ECOSYSTEM_NPM,
        });

        writer.add_package(LockPackage {
            name: "react".into(),
            version: "18.2.0".into(),
            integrity: "sha512-xyz789==".into(),
            resolved: "https://registry.npmjs.org/react/-/react-18.2.0.tgz".into(),
            dependencies: vec![],
            ecosystem: ECOSYSTEM_NPM,
        });

        // Write to temp dir
        let dir = std::env::temp_dir().join("better-lock-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let result = writer.write_both(&dir).unwrap();
        assert_eq!(result.package_count, 3);
        assert!(result.binary_size > 0);

        // Read back
        let reader = LockfileReader::from_binary(&dir.join("better.lock")).unwrap();
        assert_eq!(reader.package_count(), 3);

        // Packages are sorted by name: express, lodash, react
        let pkg0 = reader.get_package(0).unwrap();
        assert_eq!(pkg0.name, "express");
        assert_eq!(pkg0.version, "4.18.2");

        let pkg1 = reader.get_package(1).unwrap();
        assert_eq!(pkg1.name, "lodash");
        assert_eq!(pkg1.version, "4.17.21");

        let pkg2 = reader.get_package(2).unwrap();
        assert_eq!(pkg2.name, "react");
        assert_eq!(pkg2.version, "18.2.0");

        // Test find_package (binary search)
        let found = reader.find_package("lodash").unwrap();
        assert_eq!(found.version, "4.17.21");

        let found = reader.find_package("react").unwrap();
        assert_eq!(found.version, "18.2.0");

        assert!(reader.find_package("nonexistent").is_none());

        // Verify JSON sidecar exists
        let json_path = dir.join("better.lock.json");
        assert!(json_path.exists());
        let json_content = fs::read_to_string(&json_path).unwrap();
        assert!(json_content.contains("\"lodash@4.17.21\""));
        assert!(json_content.contains("\"express@4.18.2\""));
        assert!(json_content.contains("\"react@18.2.0\""));
        assert!(json_content.contains("\"fingerprint\""));

        // Cleanup
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_empty_lockfile() {
        let writer = LockfileWriter::new();
        let dir = std::env::temp_dir().join("better-lock-empty-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let result = writer.write_both(&dir).unwrap();
        assert_eq!(result.package_count, 0);

        let reader = LockfileReader::from_binary(&dir.join("better.lock")).unwrap();
        assert_eq!(reader.package_count(), 0);
        assert!(reader.find_package("anything").is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_corrupted_magic() {
        let dir = std::env::temp_dir().join("better-lock-corrupt-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let path = dir.join("better.lock");
        fs::write(&path, b"BAD_DATA_HERE").unwrap();

        let result = LockfileReader::from_binary(&path);
        assert!(result.is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_v2_roundtrip_multi_ecosystem() {
        let mut writer = LockfileWriter::new();

        // npm packages
        writer.add_package(LockPackage {
            name: "express".into(),
            version: "4.18.2".into(),
            integrity: "sha512-abc123==".into(),
            resolved: "https://registry.npmjs.org/express/-/express-4.18.2.tgz".into(),
            dependencies: vec![],
            ecosystem: ECOSYSTEM_NPM,
        });

        // Python packages
        writer.add_package(LockPackage {
            name: "flask".into(),
            version: "2.3.2".into(),
            integrity: "sha256:def456".into(),
            resolved: "https://pypi.org/simple/flask/".into(),
            dependencies: vec![],
            ecosystem: ECOSYSTEM_PYTHON,
        });
        writer.add_package(LockPackage {
            name: "requests".into(),
            version: "2.31.0".into(),
            integrity: "sha256:ghi789".into(),
            resolved: "https://pypi.org/simple/requests/".into(),
            dependencies: vec![],
            ecosystem: ECOSYSTEM_PYTHON,
        });

        let dir = std::env::temp_dir().join("better-lock-v2-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let result = writer.write_both_v2(&dir).unwrap();
        assert_eq!(result.package_count, 3);

        // Read back
        let reader = LockfileReader::from_binary(&dir.join("better.lock")).unwrap();
        assert_eq!(reader.version(), 2);
        assert_eq!(reader.package_count(), 3);
        assert_eq!(reader.ecosystem_count(), 2);

        // Check ecosystem sections
        let sections = reader.ecosystem_sections();
        assert_eq!(sections.len(), 2);
        assert_eq!(sections[0].0, ECOSYSTEM_NPM);
        assert_eq!(sections[0].2, 1); // 1 npm package
        assert_eq!(sections[1].0, ECOSYSTEM_PYTHON);
        assert_eq!(sections[1].2, 2); // 2 python packages

        // Verify packages are readable
        let pkg0 = reader.get_package(0).unwrap();
        assert_eq!(pkg0.name, "express");
        assert_eq!(pkg0.ecosystem, ECOSYSTEM_NPM);

        let pkg1 = reader.get_package(1).unwrap();
        assert_eq!(pkg1.name, "flask");
        assert_eq!(pkg1.ecosystem, ECOSYSTEM_PYTHON);

        // Verify JSON sidecar has v2 structure
        let json_path = dir.join("better.lock.json");
        let json_content = fs::read_to_string(&json_path).unwrap();
        assert!(json_content.contains("\"version\":2"));
        assert!(json_content.contains("\"npm\""));
        assert!(json_content.contains("\"python\""));

        let _ = fs::remove_dir_all(&dir);
    }
}
