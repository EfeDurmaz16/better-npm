use super::pypi::{PackageType, ReleaseFile};

/// Wheel filename: {distribution}-{version}(-{build})?-{python}-{abi}-{platform}.whl
#[derive(Debug, Clone)]
pub struct WheelTag {
    pub python: Vec<String>,   // e.g., ["cp312", "cp311"]
    pub abi: Vec<String>,      // e.g., ["cp312", "abi3", "none"]
    pub platform: Vec<String>, // e.g., ["macosx_14_0_arm64", "manylinux_2_17_x86_64", "any"]
}

#[derive(Debug, Clone)]
pub struct WheelFilename {
    pub distribution: String,
    pub version: String,
    pub build: Option<String>,
    pub tags: WheelTag,
}

impl WheelFilename {
    /// Parse a wheel filename.
    /// Format: {dist}-{ver}(-{build})?-{python}-{abi}-{platform}.whl
    pub fn parse(filename: &str) -> Result<Self, String> {
        let name = filename
            .strip_suffix(".whl")
            .ok_or_else(|| format!("Not a wheel filename: {}", filename))?;

        let parts: Vec<&str> = name.split('-').collect();

        // Minimum: dist-ver-python-abi-platform (5 parts)
        // With build: dist-ver-build-python-abi-platform (6 parts)
        if parts.len() < 5 {
            return Err(format!("Invalid wheel filename: {}", filename));
        }

        let (distribution, version, build, python_tag, abi_tag, platform_tag) = if parts.len() >= 6
        {
            // Check if 3rd part looks like a build tag (starts with digit)
            if parts[2].chars().next().map_or(false, |c| c.is_ascii_digit()) {
                (
                    parts[0].to_string(),
                    parts[1].to_string(),
                    Some(parts[2].to_string()),
                    parts[3],
                    parts[4],
                    parts[5],
                )
            } else {
                // Handle distributions with hyphens in name
                let dist = parts[..parts.len() - 4].join("-");
                let idx = parts.len() - 4;
                (
                    dist,
                    parts[idx].to_string(),
                    None,
                    parts[idx + 1],
                    parts[idx + 2],
                    parts[idx + 3],
                )
            }
        } else {
            (
                parts[0].to_string(),
                parts[1].to_string(),
                None,
                parts[2],
                parts[3],
                parts[4],
            )
        };

        let python: Vec<String> = python_tag.split('.').map(|s| s.to_string()).collect();
        let abi: Vec<String> = abi_tag.split('.').map(|s| s.to_string()).collect();
        let platform: Vec<String> = platform_tag.split('.').map(|s| s.to_string()).collect();

        Ok(WheelFilename {
            distribution,
            version,
            build,
            tags: WheelTag {
                python,
                abi,
                platform,
            },
        })
    }
}

/// Current platform tags for wheel compatibility matching.
#[derive(Debug, Clone)]
pub struct PlatformTags {
    pub python_tag: String,   // e.g., "cp312"
    pub abi_tag: String,      // e.g., "cp312"
    pub platform_tag: String, // e.g., "macosx_14_0_arm64"
}

impl PlatformTags {
    /// Detect current platform tags based on Python version.
    pub fn detect(python_version: &str) -> Self {
        let parts: Vec<&str> = python_version.split('.').collect();
        let major = parts.first().unwrap_or(&"3");
        let minor = parts.get(1).unwrap_or(&"12");
        let python_tag = format!("cp{}{}", major, minor);
        let abi_tag = python_tag.clone();

        let platform_tag = detect_platform_tag();

        PlatformTags {
            python_tag,
            abi_tag,
            platform_tag,
        }
    }

    /// Score a wheel's compatibility. Higher = better match. None = incompatible.
    pub fn compatibility_score(&self, wheel: &WheelTag) -> Option<u32> {
        let python_score = self.score_python_tag(&wheel.python)?;
        let abi_score = self.score_abi_tag(&wheel.abi)?;
        let platform_score = self.score_platform_tag(&wheel.platform)?;

        Some(python_score * 100 + abi_score * 10 + platform_score)
    }

    fn score_python_tag(&self, tags: &[String]) -> Option<u32> {
        for tag in tags {
            if tag == &self.python_tag {
                return Some(10); // Exact match
            }
            if tag.starts_with("cp3") {
                return Some(5); // Compatible CPython
            }
            if tag == "py3" || tag == "py3.none" {
                return Some(3); // Universal Python 3
            }
            if tag == "py2.py3" {
                return Some(1); // Universal
            }
        }
        None
    }

    fn score_abi_tag(&self, tags: &[String]) -> Option<u32> {
        for tag in tags {
            if tag == &self.abi_tag {
                return Some(10); // Exact ABI match
            }
            if tag == "abi3" {
                return Some(7); // Stable ABI
            }
            if tag == "none" {
                return Some(3); // No ABI requirement
            }
        }
        None
    }

    fn score_platform_tag(&self, tags: &[String]) -> Option<u32> {
        for tag in tags {
            if tag == &self.platform_tag {
                return Some(10); // Exact platform match
            }
            if is_compatible_platform(&self.platform_tag, tag) {
                return Some(7); // Compatible platform
            }
            if tag == "any" {
                return Some(3); // Universal
            }
        }
        None
    }
}

/// Detect the current platform tag.
fn detect_platform_tag() -> String {
    #[cfg(target_os = "macos")]
    {
        let arch = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x86_64"
        };
        // Use a conservative macOS version for broader compatibility
        format!("macosx_11_0_{}", arch)
    }

    #[cfg(target_os = "linux")]
    {
        let arch = if cfg!(target_arch = "aarch64") {
            "aarch64"
        } else {
            "x86_64"
        };
        format!("manylinux_2_17_{}", arch)
    }

    #[cfg(target_os = "windows")]
    {
        if cfg!(target_arch = "x86_64") {
            "win_amd64".to_string()
        } else {
            "win32".to_string()
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        "any".to_string()
    }
}

/// Check if a wheel platform tag is compatible with the current platform.
fn is_compatible_platform(current: &str, wheel_tag: &str) -> bool {
    // macOS: macosx_X_Y_arch — compatible if arch matches and version <=
    if current.starts_with("macosx_") && wheel_tag.starts_with("macosx_") {
        let current_parts: Vec<&str> = current.split('_').collect();
        let wheel_parts: Vec<&str> = wheel_tag.split('_').collect();
        if current_parts.len() >= 4 && wheel_parts.len() >= 4 {
            let current_arch = current_parts.last().unwrap();
            let wheel_arch = wheel_parts.last().unwrap();
            if current_arch == wheel_arch || *wheel_arch == "universal2" {
                return true;
            }
        }
        return false;
    }

    // Linux: manylinux_X_Y_arch or manylinux2014_arch, etc.
    if current.contains("manylinux") && wheel_tag.contains("manylinux") {
        // Extract arch
        let current_arch = current.rsplit('_').next().unwrap_or("");
        let wheel_arch = wheel_tag.rsplit('_').next().unwrap_or("");
        if current_arch == wheel_arch {
            return true;
        }
        return false;
    }

    // Linux: musllinux
    if current.contains("musllinux") && wheel_tag.contains("musllinux") {
        let current_arch = current.rsplit('_').next().unwrap_or("");
        let wheel_arch = wheel_tag.rsplit('_').next().unwrap_or("");
        return current_arch == wheel_arch;
    }

    false
}

/// Select the best wheel from a list of release files for the given platform.
/// Returns None if no compatible wheel is found (caller falls back to sdist).
pub fn select_best_wheel<'a>(
    files: &'a [ReleaseFile],
    platform: &PlatformTags,
) -> Option<&'a ReleaseFile> {
    let mut best: Option<(&ReleaseFile, u32)> = None;

    for file in files {
        // Skip non-wheels
        if file.packagetype != PackageType::BdistWheel {
            continue;
        }

        // Skip yanked files
        if file.yanked {
            continue;
        }

        // Parse wheel filename
        let wheel = match WheelFilename::parse(&file.filename) {
            Ok(w) => w,
            Err(_) => continue,
        };

        // Score compatibility
        if let Some(score) = platform.compatibility_score(&wheel.tags) {
            match &best {
                Some((_, best_score)) if score <= *best_score => {}
                _ => {
                    best = Some((file, score));
                }
            }
        }
    }

    best.map(|(file, _)| file)
}

/// Select the best sdist from a list of release files.
pub fn select_sdist<'a>(files: &'a [ReleaseFile]) -> Option<&'a ReleaseFile> {
    files
        .iter()
        .filter(|f| f.packagetype == PackageType::Sdist && !f.yanked)
        .last() // Prefer the last (usually most recent) sdist
}

/// Preference order for package type selection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PackagePreference {
    Sdist = 1,
    UniversalWheel = 2,
    PlatformWheel = 3,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_wheel_filename() {
        let wf =
            WheelFilename::parse("flask-3.1.0-py3-none-any.whl").unwrap();
        assert_eq!(wf.distribution, "flask");
        assert_eq!(wf.version, "3.1.0");
        assert!(wf.build.is_none());
        assert_eq!(wf.tags.python, vec!["py3"]);
        assert_eq!(wf.tags.abi, vec!["none"]);
        assert_eq!(wf.tags.platform, vec!["any"]);
    }

    #[test]
    fn test_parse_platform_wheel() {
        let wf = WheelFilename::parse(
            "numpy-2.2.3-cp312-cp312-macosx_14_0_arm64.whl",
        )
        .unwrap();
        assert_eq!(wf.distribution, "numpy");
        assert_eq!(wf.version, "2.2.3");
        assert_eq!(wf.tags.python, vec!["cp312"]);
        assert_eq!(wf.tags.abi, vec!["cp312"]);
        assert_eq!(wf.tags.platform, vec!["macosx_14_0_arm64"]);
    }

    #[test]
    fn test_platform_tags_detect() {
        let tags = PlatformTags::detect("3.12.1");
        assert_eq!(tags.python_tag, "cp312");
        assert_eq!(tags.abi_tag, "cp312");
        assert!(!tags.platform_tag.is_empty());
    }

    #[test]
    fn test_compatibility_score() {
        let platform = PlatformTags {
            python_tag: "cp312".to_string(),
            abi_tag: "cp312".to_string(),
            platform_tag: "macosx_11_0_arm64".to_string(),
        };

        // Exact match wheel
        let exact = WheelTag {
            python: vec!["cp312".to_string()],
            abi: vec!["cp312".to_string()],
            platform: vec!["macosx_11_0_arm64".to_string()],
        };
        let exact_score = platform.compatibility_score(&exact).unwrap();

        // Universal wheel
        let universal = WheelTag {
            python: vec!["py3".to_string()],
            abi: vec!["none".to_string()],
            platform: vec!["any".to_string()],
        };
        let universal_score = platform.compatibility_score(&universal).unwrap();

        assert!(exact_score > universal_score, "platform wheel > universal");
    }

    #[test]
    fn test_select_best_wheel() {
        use super::super::pypi::{FileDigests, PackageType, ReleaseFile};

        let platform = PlatformTags {
            python_tag: "cp312".to_string(),
            abi_tag: "cp312".to_string(),
            platform_tag: "macosx_11_0_arm64".to_string(),
        };

        let files = vec![
            ReleaseFile {
                filename: "pkg-1.0.0-py3-none-any.whl".to_string(),
                url: "https://example.com/1".to_string(),
                size: 1000,
                digests: FileDigests {
                    sha256: "aaa".to_string(),
                    md5: None,
                },
                requires_python: None,
                packagetype: PackageType::BdistWheel,
                python_version: None,
                yanked: false,
                yanked_reason: None,
            },
            ReleaseFile {
                filename: "pkg-1.0.0-cp312-cp312-macosx_11_0_arm64.whl".to_string(),
                url: "https://example.com/2".to_string(),
                size: 2000,
                digests: FileDigests {
                    sha256: "bbb".to_string(),
                    md5: None,
                },
                requires_python: None,
                packagetype: PackageType::BdistWheel,
                python_version: None,
                yanked: false,
                yanked_reason: None,
            },
            ReleaseFile {
                filename: "pkg-1.0.0.tar.gz".to_string(),
                url: "https://example.com/3".to_string(),
                size: 3000,
                digests: FileDigests {
                    sha256: "ccc".to_string(),
                    md5: None,
                },
                requires_python: None,
                packagetype: PackageType::Sdist,
                python_version: None,
                yanked: false,
                yanked_reason: None,
            },
        ];

        let best = select_best_wheel(&files, &platform);
        assert!(best.is_some());
        assert_eq!(best.unwrap().filename, "pkg-1.0.0-cp312-cp312-macosx_11_0_arm64.whl");
    }
}
