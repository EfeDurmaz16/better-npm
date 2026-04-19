use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

/// Result of extracting a wheel or sdist into a site-packages directory.
#[derive(Debug)]
pub struct ExtractResult {
    /// Number of individual files written.
    pub files_extracted: u64,
    /// Entry-point script names created in bin_dir.
    pub entry_points: Vec<String>,
    /// Path to the .dist-info directory written.
    pub dist_info_path: PathBuf,
}

/// Extract a wheel (.whl, which is a ZIP archive) into `site_packages`.
///
/// The wheel layout is:
///   {name}-{ver}.dist-info/   — metadata
///   {name}-{ver}.data/        — data files (scripts, headers, …)
///   <package dirs>            — pure Python / compiled extensions
///
/// After extraction all contents are placed flat inside `site_packages`.
/// The `.data/scripts/` sub-directory entries are also written into `bin_dir`.
pub fn extract_wheel(
    wheel_path: &Path,
    site_packages: &Path,
    bin_dir: &Path,
) -> Result<ExtractResult, String> {
    let file = fs::File::open(wheel_path)
        .map_err(|e| format!("failed to open wheel {}: {}", wheel_path.display(), e))?;

    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("failed to read wheel archive: {}", e))?;

    fs::create_dir_all(site_packages)
        .map_err(|e| format!("failed to create site-packages: {}", e))?;
    fs::create_dir_all(bin_dir)
        .map_err(|e| format!("failed to create bin dir: {}", e))?;

    let mut files_extracted: u64 = 0;
    let mut dist_info_path = PathBuf::new();
    let mut entry_points: Vec<String> = Vec::new();
    let mut entry_points_txt: Option<String> = None;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("failed to read zip entry {}: {}", i, e))?;

        let name = entry.name().to_string();

        // Skip directory entries
        if name.ends_with('/') {
            continue;
        }

        // Determine destination path
        let dest = if let Some(rest) = strip_data_prefix(&name) {
            // .data/scripts/ -> bin_dir
            if rest.starts_with("scripts/") {
                let script_name = rest.trim_start_matches("scripts/");
                bin_dir.join(script_name)
            } else {
                // .data/purelib/, .data/platlib/, .data/data/ -> site_packages
                let sub = rest
                    .trim_start_matches("purelib/")
                    .trim_start_matches("platlib/")
                    .trim_start_matches("data/");
                site_packages.join(sub)
            }
        } else {
            // Normal wheel entry — goes directly into site_packages
            site_packages.join(&name)
        };

        // Track .dist-info directory
        if name.contains(".dist-info/") && dist_info_path.as_os_str().is_empty() {
            let parts: Vec<_> = name.split('/').collect();
            if !parts.is_empty() {
                dist_info_path = site_packages.join(parts[0]);
            }
        }

        // Capture entry_points.txt for post-processing
        if name.contains(".dist-info/entry_points.txt") {
            let mut content = String::new();
            entry
                .read_to_string(&mut content)
                .map_err(|e| format!("failed to read entry_points.txt: {}", e))?;
            // Write to disk before moving into Option
            let mut ep_file = create_file_with_parents(&dest)?;
            ep_file
                .write_all(content.as_bytes())
                .map_err(|e| format!("failed to write entry_points.txt: {}", e))?;
            entry_points_txt = Some(content);
            files_extracted += 1;
            continue;
        }

        // Write the entry
        let mut buf = Vec::new();
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("failed to read zip entry '{}': {}", name, e))?;

        let mut out = create_file_with_parents(&dest)?;
        out.write_all(&buf)
            .map_err(|e| format!("failed to write '{}': {}", dest.display(), e))?;

        // Mark scripts executable on Unix
        #[cfg(unix)]
        if dest.starts_with(bin_dir) {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = out.metadata().map(|m| m.permissions()).unwrap_or_else(|_| {
                std::fs::Permissions::from_mode(0o755)
            });
            perms.set_mode(perms.mode() | 0o111);
            let _ = std::fs::set_permissions(&dest, perms);
        }

        files_extracted += 1;
    }

    // Parse entry_points.txt and create console_script wrappers
    if let Some(txt) = entry_points_txt {
        let scripts = parse_console_scripts(&txt);
        for (script_name, entry_point) in &scripts {
            let wrapper_path = bin_dir.join(script_name);
            write_script_wrapper(&wrapper_path, entry_point)?;
            entry_points.push(script_name.clone());
        }
    }

    Ok(ExtractResult {
        files_extracted,
        entry_points,
        dist_info_path,
    })
}

/// Strip the `{name}-{ver}.data/` prefix from a wheel entry name.
/// Returns the path component after that prefix, or None.
fn strip_data_prefix(entry_name: &str) -> Option<&str> {
    let slash = entry_name.find('/')?;
    let dir = &entry_name[..slash];
    if dir.ends_with(".data") {
        Some(&entry_name[slash + 1..])
    } else {
        None
    }
}

/// Create a file, creating all parent directories as needed.
fn create_file_with_parents(path: &Path) -> Result<fs::File, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create dir {}: {}", parent.display(), e))?;
    }
    fs::File::create(path).map_err(|e| format!("failed to create file {}: {}", path.display(), e))
}

/// Parse `[console_scripts]` section from `entry_points.txt`.
///
/// Format:
/// ```ini
/// [console_scripts]
/// myapp = mypackage.cli:main
/// ```
fn parse_console_scripts(content: &str) -> Vec<(String, String)> {
    let mut in_console = false;
    let mut result = Vec::new();

    for line in content.lines() {
        let line = line.trim();
        if line == "[console_scripts]" {
            in_console = true;
            continue;
        }
        if line.starts_with('[') {
            in_console = false;
            continue;
        }
        if in_console && line.contains('=') {
            if let Some((name, ep)) = line.split_once('=') {
                result.push((name.trim().to_string(), ep.trim().to_string()));
            }
        }
    }

    result
}

/// Write a Python console_script wrapper in `bin_dir`.
///
/// The wrapper launches the entry-point using the venv's Python so it works
/// even when the venv is not explicitly activated.
fn write_script_wrapper(path: &Path, entry_point: &str) -> Result<(), String> {
    // entry_point is "module.submodule:function"
    let (module, func) = if let Some((m, f)) = entry_point.split_once(':') {
        (m.trim(), f.trim())
    } else {
        (entry_point, "main")
    };

    // Resolve the Python interpreter relative to the script's own bin dir.
    let script = format!(
        "#!/bin/sh\n\
         _dir=\"$(dirname \"$0\")\"\n\
         _py=\"$_dir/python3\"\n\
         [ -x \"$_py\" ] || _py=\"$_dir/python\"\n\
         [ -x \"$_py\" ] || _py=python3\n\
         exec \"$_py\" -c \"\
         import sys; from {module} import {func}; sys.exit({func}())\" \"$@\"\n",
        module = module,
        func = func,
    );

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create bin dir: {}", e))?;
    }

    fs::write(path, script.as_bytes())
        .map_err(|e| format!("failed to write wrapper {}: {}", path.display(), e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(path)
            .map(|m| m.permissions())
            .unwrap_or_else(|_| std::fs::Permissions::from_mode(0o755));
        perms.set_mode(perms.mode() | 0o755);
        let _ = fs::set_permissions(path, perms);
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_test_wheel(dir: &Path, name: &str) -> PathBuf {
        let whl_path = dir.join(format!("{}.whl", name));
        let file = fs::File::create(&whl_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::FileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);

        zip.start_file("mypackage/__init__.py", opts).unwrap();
        zip.write_all(b"# mypackage\n").unwrap();

        zip.start_file("mypackage-1.0.dist-info/METADATA", opts).unwrap();
        zip.write_all(b"Metadata-Version: 2.1\nName: mypackage\nVersion: 1.0\n").unwrap();

        zip.start_file("mypackage-1.0.dist-info/entry_points.txt", opts).unwrap();
        zip.write_all(b"[console_scripts]\nmycli = mypackage:main\n").unwrap();

        zip.finish().unwrap();
        whl_path
    }

    #[test]
    fn strip_data_prefix_works() {
        assert_eq!(
            strip_data_prefix("mypackage-1.0.data/scripts/mycli"),
            Some("scripts/mycli")
        );
        assert_eq!(strip_data_prefix("mypackage/__init__.py"), None);
    }

    #[test]
    fn parse_console_scripts_basic() {
        let txt = "[console_scripts]\nmycli = mypackage:main\n";
        let scripts = parse_console_scripts(txt);
        assert_eq!(scripts.len(), 1);
        assert_eq!(scripts[0].0, "mycli");
        assert_eq!(scripts[0].1, "mypackage:main");
    }

    #[test]
    fn parse_console_scripts_ignores_other_sections() {
        let txt = "[gui_scripts]\ngui = pkg:gui\n[console_scripts]\ncli = pkg:main\n";
        let scripts = parse_console_scripts(txt);
        assert_eq!(scripts.len(), 1);
        assert_eq!(scripts[0].0, "cli");
    }

    #[test]
    fn parse_console_scripts_empty() {
        let scripts = parse_console_scripts("[console_scripts]\n");
        assert!(scripts.is_empty());
    }

    #[test]
    fn extract_wheel_creates_files() {
        let tmp = tempfile::tempdir().unwrap();
        let whl = make_test_wheel(tmp.path(), "mypackage-1.0-py3-none-any");
        let site = tmp.path().join("site-packages");
        let bin = tmp.path().join("bin");

        let result = extract_wheel(&whl, &site, &bin).unwrap();

        assert!(result.files_extracted >= 2);
        assert!(site.join("mypackage/__init__.py").exists());
        assert!(site.join("mypackage-1.0.dist-info/METADATA").exists());
    }

    #[test]
    fn extract_wheel_creates_entry_point_wrapper() {
        let tmp = tempfile::tempdir().unwrap();
        let whl = make_test_wheel(tmp.path(), "mypackage-1.0-py3-none-any");
        let site = tmp.path().join("site-packages");
        let bin = tmp.path().join("bin");

        let result = extract_wheel(&whl, &site, &bin).unwrap();

        assert!(result.entry_points.contains(&"mycli".to_string()));
        assert!(bin.join("mycli").exists());
    }

    #[test]
    fn extract_wheel_dist_info_path() {
        let tmp = tempfile::tempdir().unwrap();
        let whl = make_test_wheel(tmp.path(), "mypackage-1.0-py3-none-any");
        let site = tmp.path().join("site-packages");
        let bin = tmp.path().join("bin");

        let result = extract_wheel(&whl, &site, &bin).unwrap();

        assert!(result.dist_info_path.to_string_lossy().contains("dist-info"));
    }

    #[test]
    fn extract_wheel_missing_file_returns_err() {
        let tmp = tempfile::tempdir().unwrap();
        let result =
            extract_wheel(&tmp.path().join("nonexistent.whl"), &tmp.path().join("sp"), &tmp.path().join("bin"));
        assert!(result.is_err());
    }

    #[test]
    fn write_script_wrapper_creates_executable() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("mycli");
        write_script_wrapper(&path, "mypackage:main").unwrap();

        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("mypackage"));
        assert!(content.contains("main"));
        assert!(content.starts_with("#!/bin/sh"));
    }
}
