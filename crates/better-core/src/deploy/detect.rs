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
