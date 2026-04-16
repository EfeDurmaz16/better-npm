use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Result of creating a virtual environment.
#[derive(Debug)]
pub struct VenvCreateResult {
    pub venv_path: PathBuf,
    pub python_path: PathBuf,
    pub created: bool,
    pub python_version: String,
}

/// Environment variables needed to activate a venv.
#[derive(Debug, Clone)]
pub struct VenvActivation {
    pub virtual_env: PathBuf,
    pub path_prepend: PathBuf,
    pub env_vars: HashMap<String, String>,
}

/// Detect the best Python interpreter available on the system.
pub fn detect_python() -> Option<String> {
    // Try common Python interpreter names in order of preference
    let candidates = ["python3", "python", "python3.12", "python3.11", "python3.10"];
    for candidate in &candidates {
        if let Ok(output) = Command::new(candidate)
            .args(["--version"])
            .output()
        {
            if output.status.success() {
                let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if version.is_empty() {
                    // Some Python versions print to stderr
                    let v2 = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    if v2.starts_with("Python ") {
                        return Some(candidate.to_string());
                    }
                } else if version.starts_with("Python ") {
                    return Some(candidate.to_string());
                }
            }
        }
    }
    None
}

/// Get the Python version string from an interpreter.
pub fn python_version(python: &str) -> Option<String> {
    let output = Command::new(python)
        .args(["--version"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.starts_with("Python ") {
        return Some(stdout["Python ".len()..].to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.starts_with("Python ") {
        return Some(stderr["Python ".len()..].to_string());
    }
    None
}

/// Detect the `requires-python` field from pyproject.toml.
pub fn detect_requires_python(project_root: &Path) -> Option<String> {
    let pyproject = project_root.join("pyproject.toml");
    let content = fs::read_to_string(&pyproject).ok()?;

    // Simple TOML parsing: find requires-python in [project] section
    let mut in_project = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == "[project]" {
            in_project = true;
            continue;
        }
        if trimmed.starts_with('[') && trimmed != "[project]" {
            in_project = false;
            continue;
        }
        if in_project && trimmed.starts_with("requires-python") {
            if let Some(eq_pos) = trimmed.find('=') {
                let value = trimmed[eq_pos + 1..].trim();
                // Strip quotes
                let value = value.trim_matches('"').trim_matches('\'');
                return Some(value.to_string());
            }
        }
    }
    None
}

/// Create a virtual environment in the project root.
///
/// Creates `.venv/` using `python3 -m venv` (or the detected interpreter).
/// If `.venv/` already exists, returns immediately without recreating.
pub fn create_venv(project_root: &Path) -> Result<VenvCreateResult, String> {
    let venv_path = project_root.join(".venv");

    // Check if venv already exists
    let venv_python = venv_bin_path(&venv_path, "python");
    if venv_python.exists() {
        let version = python_version(venv_python.to_str().unwrap_or("python3"))
            .unwrap_or_else(|| "unknown".to_string());
        return Ok(VenvCreateResult {
            venv_path: venv_path.clone(),
            python_path: venv_python,
            created: false,
            python_version: version,
        });
    }

    // Detect Python interpreter
    let python = detect_python()
        .ok_or_else(|| "No Python interpreter found. Install Python 3 and ensure it is on PATH.".to_string())?;

    let version = python_version(&python)
        .unwrap_or_else(|| "unknown".to_string());

    // Check requires-python compatibility (informational only)
    if let Some(requires) = detect_requires_python(project_root) {
        eprintln!("info: project requires Python {requires}, using {python} ({version})");
    }

    // Create the venv
    let output = Command::new(&python)
        .args(["-m", "venv", ".venv"])
        .current_dir(project_root)
        .output()
        .map_err(|e| format!("Failed to run '{python} -m venv .venv': {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to create venv: {stderr}"));
    }

    let created_python = venv_bin_path(&venv_path, "python");

    Ok(VenvCreateResult {
        venv_path,
        python_path: created_python,
        created: true,
        python_version: version,
    })
}

/// Return the environment variables needed to activate a venv.
///
/// This does NOT modify the current process — it returns the env vars
/// so callers can apply them to child processes.
pub fn activate_env(project_root: &Path) -> Result<VenvActivation, String> {
    let venv_path = project_root.join(".venv");
    if !venv_path.exists() {
        return Err("No .venv directory found. Run 'better install' first.".to_string());
    }

    let bin_dir = venv_bin_dir(&venv_path);
    if !bin_dir.exists() {
        return Err(format!("venv bin directory not found: {}", bin_dir.display()));
    }

    let mut env_vars = HashMap::new();

    // VIRTUAL_ENV points to the venv root
    env_vars.insert(
        "VIRTUAL_ENV".to_string(),
        venv_path.to_string_lossy().to_string(),
    );

    // Prepend venv bin to PATH
    let current_path = std::env::var("PATH").unwrap_or_default();
    let new_path = format!("{}:{}", bin_dir.display(), current_path);
    env_vars.insert("PATH".to_string(), new_path);

    // Unset PYTHONHOME if set (it can interfere with venv)
    env_vars.insert("PYTHONHOME".to_string(), String::new());

    Ok(VenvActivation {
        virtual_env: venv_path,
        path_prepend: bin_dir,
        env_vars,
    })
}

/// Build environment variables for running a command in a Python project.
///
/// Prepends `.venv/bin` to PATH so that `python`, `pip`, etc. resolve
/// to the venv's copies.
pub fn venv_run_env(project_root: &Path) -> HashMap<String, String> {
    let mut env = HashMap::new();
    let venv_path = project_root.join(".venv");
    let bin_dir = venv_bin_dir(&venv_path);

    if bin_dir.exists() {
        let current_path = std::env::var("PATH").unwrap_or_default();
        env.insert(
            "PATH".to_string(),
            format!("{}:{}", bin_dir.display(), current_path),
        );
        env.insert(
            "VIRTUAL_ENV".to_string(),
            venv_path.to_string_lossy().to_string(),
        );
    }

    env
}

/// Spawn a subshell with the venv activated.
///
/// Uses the user's $SHELL (or /bin/bash as fallback).
pub fn spawn_shell(project_root: &Path) -> Result<i32, String> {
    let activation = activate_env(project_root)?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());

    let mut cmd = Command::new(&shell);
    cmd.current_dir(project_root);

    // Apply venv environment
    for (k, v) in &activation.env_vars {
        if v.is_empty() {
            cmd.env_remove(k);
        } else {
            cmd.env(k, v);
        }
    }

    // Set a PS1 hint so the user knows they're in a venv
    let venv_name = activation
        .virtual_env
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| ".venv".to_string());
    cmd.env("BETTER_VENV", &venv_name);

    let status = cmd
        .status()
        .map_err(|e| format!("Failed to spawn shell: {e}"))?;

    Ok(status.code().unwrap_or(-1))
}

/// Check if a project is a Python project (has pyproject.toml or requirements.txt).
pub fn is_python_project(project_root: &Path) -> bool {
    project_root.join("pyproject.toml").exists()
        || project_root.join("requirements.txt").exists()
        || project_root.join("setup.py").exists()
        || project_root.join("setup.cfg").exists()
}

// --- Platform helpers ---

/// Get the bin directory inside a venv (platform-dependent).
fn venv_bin_dir(venv_path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        venv_path.join("Scripts")
    }
    #[cfg(not(windows))]
    {
        venv_path.join("bin")
    }
}

/// Get the path to a binary inside the venv bin dir.
fn venv_bin_path(venv_path: &Path, name: &str) -> PathBuf {
    #[cfg(windows)]
    {
        venv_path.join("Scripts").join(format!("{name}.exe"))
    }
    #[cfg(not(windows))]
    {
        venv_path.join("bin").join(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_requires_python() {
        let dir = std::env::temp_dir().join("better-venv-test-requires");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let pyproject = "[project]\nname = \"test\"\nrequires-python = \">=3.10\"\n";
        fs::write(dir.join("pyproject.toml"), pyproject).unwrap();

        let result = detect_requires_python(&dir);
        assert_eq!(result, Some(">=3.10".to_string()));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_is_python_project() {
        let dir = std::env::temp_dir().join("better-venv-test-detect");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        assert!(!is_python_project(&dir));

        fs::write(dir.join("requirements.txt"), "flask>=2.0\n").unwrap();
        assert!(is_python_project(&dir));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_venv_bin_dir() {
        let venv = PathBuf::from("/project/.venv");
        let bin = venv_bin_dir(&venv);
        #[cfg(not(windows))]
        assert_eq!(bin, PathBuf::from("/project/.venv/bin"));
        #[cfg(windows)]
        assert_eq!(bin, PathBuf::from("/project/.venv/Scripts"));
    }

    #[test]
    fn test_activate_env_no_venv() {
        let dir = std::env::temp_dir().join("better-venv-test-noenv");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let result = activate_env(&dir);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("No .venv directory"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_is_python_project_with_pyproject_toml() {
        let dir = std::env::temp_dir().join("venv-test-pyproject");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("pyproject.toml"), "[project]\nname = \"test\"").unwrap();
        assert!(is_python_project(&dir));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_is_python_project_with_setup_py() {
        let dir = std::env::temp_dir().join("venv-test-setup-py");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("setup.py"), "from setuptools import setup; setup()").unwrap();
        assert!(is_python_project(&dir));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn detect_requires_python_missing_returns_none() {
        let dir = std::env::temp_dir().join("venv-test-no-req");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        assert!(detect_requires_python(&dir).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn venv_run_env_no_venv_returns_empty_map() {
        let dir = std::env::temp_dir().join("venv-test-runenv-empty");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let env = venv_run_env(&dir);
        // No venv bin dir → no vars inserted
        assert!(!env.contains_key("VIRTUAL_ENV"));
        let _ = fs::remove_dir_all(&dir);
    }
}
