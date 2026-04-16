// crates/better-core/src/deploy/detect.rs
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub enum Framework {
    NextJs, Remix, Astro, Vite, SvelteKit, Nuxt,
    Express, Fastify, Django, Flask, FastAPI,
    Rails, Laravel, DotNetCore, Static, Unknown,
}

#[derive(Debug, Clone, Serialize)]
pub enum DeployPlatform {
    Vercel, Cloudflare, Railway, Fly,
}

#[derive(Debug, Clone, Serialize)]
pub struct FrameworkDetection {
    pub framework: Framework,
    pub build_command: String,
    pub output_dir: String,
    pub dev_command: String,
    pub recommended_platform: DeployPlatform,
}

pub fn detect_framework(root: &Path) -> FrameworkDetection {
    // Check package.json deps
    if let Ok(pkg) = std::fs::read_to_string(root.join("package.json")) {
        if pkg.contains("\"next\"") {
            return mk(Framework::NextJs, "next build", ".next", "next dev", DeployPlatform::Vercel);
        }
        if pkg.contains("\"@remix-run/node\"") || pkg.contains("\"@remix-run/react\"") {
            return mk(Framework::Remix, "remix build", "build", "remix dev", DeployPlatform::Fly);
        }
        if pkg.contains("\"astro\"") {
            return mk(Framework::Astro, "astro build", "dist", "astro dev", DeployPlatform::Cloudflare);
        }
        if pkg.contains("\"@sveltejs/kit\"") {
            return mk(Framework::SvelteKit, "vite build", "build", "vite dev", DeployPlatform::Vercel);
        }
        if pkg.contains("\"nuxt\"") {
            return mk(Framework::Nuxt, "nuxt build", ".output", "nuxt dev", DeployPlatform::Vercel);
        }
        if pkg.contains("\"vite\"") {
            return mk(Framework::Vite, "vite build", "dist", "vite dev", DeployPlatform::Cloudflare);
        }
        if pkg.contains("\"express\"") || pkg.contains("\"fastify\"") {
            return mk(Framework::Express, "", "", "node server.js", DeployPlatform::Railway);
        }
    }

    // Python
    if root.join("manage.py").exists() {
        return mk(Framework::Django, "python manage.py collectstatic --noinput", "staticfiles", "python manage.py runserver", DeployPlatform::Railway);
    }
    if root.join("pyproject.toml").exists() || root.join("requirements.txt").exists() {
        return mk(Framework::Flask, "", "", "python app.py", DeployPlatform::Railway);
    }

    // Ruby
    if root.join("Gemfile").exists() && root.join("config.ru").exists() {
        return mk(Framework::Rails, "rails assets:precompile", "public/assets", "rails server", DeployPlatform::Railway);
    }

    // PHP
    if root.join("composer.json").exists() {
        return mk(Framework::Laravel, "php artisan optimize", "public", "php artisan serve", DeployPlatform::Railway);
    }

    // .NET
    if let Ok(entries) = std::fs::read_dir(root) {
        for e in entries.flatten() {
            let name = e.file_name();
            let s = name.to_string_lossy();
            if s.ends_with(".csproj") || s.ends_with(".fsproj") {
                return mk(Framework::DotNetCore, "dotnet publish -c Release", "bin/Release", "dotnet run", DeployPlatform::Railway);
            }
        }
    }

    mk(Framework::Unknown, "", "", "", DeployPlatform::Railway)
}

fn mk(f: Framework, build: &str, out: &str, dev: &str, platform: DeployPlatform) -> FrameworkDetection {
    FrameworkDetection {
        framework: f,
        build_command: build.to_string(),
        output_dir: out.to_string(),
        dev_command: dev.to_string(),
        recommended_platform: platform,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_pkg(root: &Path, content: &str) {
        std::fs::create_dir_all(root).unwrap();
        let mut f = std::fs::File::create(root.join("package.json")).unwrap();
        f.write_all(content.as_bytes()).unwrap();
    }

    #[test]
    fn detect_nextjs() {
        let tmp = std::env::temp_dir().join("detect-test-next");
        write_pkg(&tmp, r#"{"dependencies":{"next":"^14.0.0"}}"#);
        let d = detect_framework(&tmp);
        assert!(matches!(d.framework, Framework::NextJs));
        assert!(matches!(d.recommended_platform, DeployPlatform::Vercel));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn detect_express() {
        let tmp = std::env::temp_dir().join("detect-test-express");
        write_pkg(&tmp, r#"{"dependencies":{"express":"^4.18.0"}}"#);
        let d = detect_framework(&tmp);
        assert!(matches!(d.framework, Framework::Express));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn detect_django_from_manage_py() {
        let tmp = std::env::temp_dir().join("detect-test-django");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::File::create(tmp.join("manage.py")).unwrap();
        let d = detect_framework(&tmp);
        assert!(matches!(d.framework, Framework::Django));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn detect_unknown_empty_dir() {
        let tmp = std::env::temp_dir().join("detect-test-unknown");
        std::fs::create_dir_all(&tmp).unwrap();
        let d = detect_framework(&tmp);
        assert!(matches!(d.framework, Framework::Unknown));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn detect_vite_project() {
        let tmp = std::env::temp_dir().join("detect-test-vite");
        write_pkg(&tmp, r#"{"dependencies":{"vite":"^4.0.0"}}"#);
        let d = detect_framework(&tmp);
        assert!(matches!(d.framework, Framework::Vite));
        assert!(!d.build_command.is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn detect_astro_project() {
        let tmp = std::env::temp_dir().join("detect-test-astro");
        write_pkg(&tmp, r#"{"dependencies":{"astro":"^4.0.0"}}"#);
        let d = detect_framework(&tmp);
        assert!(matches!(d.framework, Framework::Astro));
        assert!(matches!(d.recommended_platform, DeployPlatform::Cloudflare));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn detect_rails_from_gemfile_and_config_ru() {
        let tmp = std::env::temp_dir().join("detect-test-rails");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::File::create(tmp.join("Gemfile")).unwrap();
        std::fs::File::create(tmp.join("config.ru")).unwrap();
        let d = detect_framework(&tmp);
        assert!(matches!(d.framework, Framework::Rails));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn detect_framework_serializes() {
        let d = mk(Framework::NextJs, "next build", ".next", "next dev", DeployPlatform::Vercel);
        let json = serde_json::to_string(&d).unwrap();
        assert!(json.contains("NextJs"));
        assert!(json.contains("Vercel"));
    }
}
