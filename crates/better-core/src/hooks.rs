use std::fs;
use std::path::Path;

use crate::types::HooksInstallResult;
use crate::{extract_json_object_raw, extract_json_object_pairs, read_package_json_scripts};

// --- C.2: Git Hooks ---

/// Extract hooks config from package.json "better.hooks" section.
fn extract_hooks_config(pkg_json_content: &str) -> Vec<(String, String)> {
    if let Some(better_raw) = extract_json_object_raw(pkg_json_content, "better") {
        extract_json_object_pairs(&better_raw, "hooks").unwrap_or_default()
    } else {
        Vec::new()
    }
}

/// Validate a commit message against conventional commit format: type(scope): description
pub fn validate_conventional_commit(message: &str) -> Result<(), String> {
    let first_line = message.lines().next().unwrap_or("").trim();
    if first_line.is_empty() {
        return Err("Empty commit message".to_string());
    }
    let valid_types = [
        "feat", "fix", "docs", "style", "refactor", "perf",
        "test", "build", "ci", "chore", "revert",
    ];
    // Check format: type(scope): desc  or  type: desc
    let colon_pos = match first_line.find(':') {
        Some(p) => p,
        None => return Err(format!("Missing colon in commit message: '{}'", first_line)),
    };
    let prefix = &first_line[..colon_pos];
    let type_name = if let Some(paren) = prefix.find('(') {
        if !prefix.ends_with(')') {
            return Err(format!("Malformed scope in commit message: '{}'", first_line));
        }
        &prefix[..paren]
    } else {
        prefix
    };
    if !valid_types.contains(&type_name) {
        return Err(format!("Invalid commit type '{}'. Valid: {}", type_name, valid_types.join(", ")));
    }
    let desc = first_line[colon_pos + 1..].trim();
    if desc.is_empty() {
        return Err("Missing description after colon".to_string());
    }
    Ok(())
}

pub fn hooks_install(project_root: &Path) -> Result<HooksInstallResult, String> {
    let git_dir = project_root.join(".git");
    if !git_dir.exists() {
        return Err("Not a git repository".to_string());
    }
    let hooks_dir = git_dir.join("hooks");
    fs::create_dir_all(&hooks_dir).map_err(|e| e.to_string())?;

    let pkg_json = project_root.join("package.json");
    let content = fs::read_to_string(&pkg_json).unwrap_or_default();
    let config_hooks = extract_hooks_config(&content);

    let from_config = !config_hooks.is_empty();
    let hook_entries: Vec<(String, String)> = if from_config {
        config_hooks
    } else {
        // Sensible defaults
        let scripts = read_package_json_scripts(project_root).unwrap_or_default();
        let mut defaults = Vec::new();
        if scripts.iter().any(|(n, _)| n == "lint") {
            defaults.push(("pre-commit".to_string(), "better-core run lint".to_string()));
        }
        if scripts.iter().any(|(n, _)| n == "test") {
            defaults.push(("pre-push".to_string(), "better-core run test".to_string()));
        }
        defaults.push(("commit-msg".to_string(), "conventional-commit".to_string()));
        defaults
    };

    let mut hooks_installed = 0u64;
    let mut installed: Vec<(String, String)> = Vec::new();

    for (hook_type, action) in &hook_entries {
        let hook_path = hooks_dir.join(hook_type);
        let script = if action == "conventional-commit" {
            format!(
                "#!/bin/sh\n# Installed by better-core hooks\n\
                MSG=$(cat \"$1\" 2>/dev/null || echo \"$1\")\n\
                if ! echo \"$MSG\" | grep -qE '^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\\(.*\\))?: .+'; then\n  \
                echo \"error: commit message must follow Conventional Commits format\" >&2\n  \
                echo \"  format: type(scope): description\" >&2\n  \
                exit 1\nfi\n"
            )
        } else {
            format!(
                "#!/bin/sh\n# Installed by better-core hooks\nexec {} \"$@\"\n",
                action
            )
        };

        fs::write(&hook_path, &script).map_err(|e| e.to_string())?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&hook_path).map_err(|e| e.to_string())?.permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&hook_path, perms).map_err(|e| e.to_string())?;
        }

        hooks_installed += 1;
        installed.push((hook_type.clone(), action.clone()));
    }

    Ok(HooksInstallResult { hooks_installed, from_config, hooks: installed })
}


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_conventional_commit_accepted() {
        assert!(validate_conventional_commit("feat: add new feature").is_ok());
        assert!(validate_conventional_commit("fix(auth): resolve login issue").is_ok());
    }

    #[test]
    fn invalid_type_rejected() {
        let r = validate_conventional_commit("blah: something");
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("Invalid commit type"));
    }

    #[test]
    fn empty_message_rejected() {
        assert!(validate_conventional_commit("").is_err());
    }

    #[test]
    fn missing_colon_rejected() {
        let r = validate_conventional_commit("feat add feature");
        assert!(r.is_err());
    }

    #[test]
    fn missing_description_rejected() {
        let r = validate_conventional_commit("feat:");
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("Missing description"));
    }

    #[test]
    fn hooks_install_not_a_git_repo_errors() {
        let tmp = std::env::temp_dir().join("hooks-test-nogit");
        std::fs::create_dir_all(&tmp).unwrap();
        let result = hooks_install(&tmp);
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
