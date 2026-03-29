use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use crate::{extract_json_object_pairs, JsonWriter};

// ── Result types ────────────────────────────────────────────────────────────

pub struct SuggestionReport {
    pub missing: Vec<MissingDep>,
    pub unused: Vec<UnusedDep>,
    pub ecosystem: String,
    pub files_scanned: usize,
    pub scan_ms: u64,
}

pub struct MissingDep {
    pub name: String,
    pub imported_in: Vec<String>,
    pub import_style: String,
    pub confidence: f64,
}

pub struct UnusedDep {
    pub name: String,
    pub declared_in: String,
    pub version: String,
    pub confidence: f64,
}

// ── Node.js builtins ────────────────────────────────────────────────────────

const NODE_BUILTINS: &[&str] = &[
    "assert", "async_hooks", "buffer", "child_process", "cluster", "console",
    "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain",
    "events", "fs", "http", "http2", "https", "inspector", "module", "net",
    "os", "path", "perf_hooks", "process", "punycode", "querystring",
    "readline", "repl", "stream", "string_decoder", "sys", "timers",
    "tls", "trace_events", "tty", "url", "util", "v8", "vm",
    "wasi", "worker_threads", "zlib",
];

// ── Python stdlib ───────────────────────────────────────────────────────────

const PYTHON_STDLIB: &[&str] = &[
    "abc", "aifc", "argparse", "array", "ast", "asynchat", "asyncio",
    "asyncore", "atexit", "base64", "bdb", "binascii", "binhex", "bisect",
    "builtins", "bz2", "calendar", "cgi", "cgitb", "chunk", "cmath",
    "cmd", "code", "codecs", "codeop", "collections", "colorsys", "compileall",
    "concurrent", "configparser", "contextlib", "contextvars", "copy",
    "copyreg", "cProfile", "crypt", "csv", "ctypes", "curses", "dataclasses",
    "datetime", "dbm", "decimal", "difflib", "dis", "distutils", "doctest",
    "email", "encodings", "enum", "errno", "faulthandler", "fcntl",
    "filecmp", "fileinput", "fnmatch", "fractions", "ftplib", "functools",
    "gc", "getopt", "getpass", "gettext", "glob", "grp", "gzip",
    "hashlib", "heapq", "hmac", "html", "http", "idlelib", "imaplib",
    "imghdr", "imp", "importlib", "inspect", "io", "ipaddress", "itertools",
    "json", "keyword", "lib2to3", "linecache", "locale", "logging",
    "lzma", "mailbox", "mailcap", "marshal", "math", "mimetypes", "mmap",
    "modulefinder", "multiprocessing", "netrc", "nis", "nntplib", "numbers",
    "operator", "optparse", "os", "ossaudiodev", "pathlib", "pdb",
    "pipes", "pkgutil", "platform", "plistlib",
    "poplib", "posix", "posixpath", "pprint", "profile", "pstats", "pty",
    "pwd", "py_compile", "pyclbr", "pydoc", "queue", "quopri", "random",
    "re", "readline", "reprlib", "resource", "rlcompleter", "runpy",
    "sched", "secrets", "select", "selectors", "shelve", "shlex", "shutil",
    "signal", "site", "smtpd", "smtplib", "sndhdr", "socket", "socketserver",
    "spwd", "sqlite3", "ssl", "stat", "statistics", "string", "stringprep",
    "struct", "subprocess", "sunau", "symtable", "sys", "sysconfig",
    "syslog", "tabnanny", "tarfile", "telnetlib", "tempfile", "termios",
    "test", "textwrap", "threading", "time", "timeit", "tkinter", "token",
    "tokenize", "tomllib", "trace", "traceback", "tracemalloc", "tty",
    "turtle", "turtledemo", "types", "typing", "unicodedata", "unittest",
    "urllib", "uu", "uuid", "venv", "warnings", "wave", "weakref",
    "webbrowser", "winreg", "winsound", "wsgiref", "xdrlib", "xml",
    "xmlrpc", "zipapp", "zipfile", "zipimport", "zlib", "_thread",
];

// ── Python import name -> PyPI package mapping ─────────────────────────────

const PYTHON_IMPORT_TO_PACKAGE: &[(&str, &str)] = &[
    ("PIL", "Pillow"),
    ("cv2", "opencv-python"),
    ("sklearn", "scikit-learn"),
    ("yaml", "PyYAML"),
    ("bs4", "beautifulsoup4"),
    ("gi", "PyGObject"),
    ("wx", "wxPython"),
    ("attr", "attrs"),
    ("dotenv", "python-dotenv"),
    ("jose", "python-jose"),
    ("jwt", "PyJWT"),
    ("dateutil", "python-dateutil"),
    ("serial", "pyserial"),
    ("usb", "pyusb"),
    ("magic", "python-magic"),
    ("Crypto", "pycryptodome"),
    ("lxml", "lxml"),
    ("numpy", "numpy"),
    ("pandas", "pandas"),
    ("matplotlib", "matplotlib"),
    ("scipy", "scipy"),
    ("flask", "Flask"),
    ("django", "Django"),
    ("fastapi", "fastapi"),
    ("pydantic", "pydantic"),
    ("requests", "requests"),
    ("httpx", "httpx"),
    ("aiohttp", "aiohttp"),
    ("celery", "celery"),
    ("redis", "redis"),
    ("boto3", "boto3"),
    ("botocore", "botocore"),
    ("google", "google-cloud-core"),
    ("sqlalchemy", "SQLAlchemy"),
    ("alembic", "alembic"),
    ("pymongo", "pymongo"),
    ("psycopg2", "psycopg2"),
    ("pg8000", "pg8000"),
    ("MySQLdb", "mysqlclient"),
    ("mysql", "mysql-connector-python"),
    ("toml", "toml"),
    ("tomli", "tomli"),
    ("rich", "rich"),
    ("click", "click"),
    ("typer", "typer"),
    ("pytest", "pytest"),
    ("hypothesis", "hypothesis"),
    ("tqdm", "tqdm"),
    ("wrapt", "wrapt"),
    ("cryptography", "cryptography"),
    ("nacl", "PyNaCl"),
    ("paramiko", "paramiko"),
    ("fabric", "fabric"),
    ("invoke", "invoke"),
    ("jinja2", "Jinja2"),
    ("markupsafe", "MarkupSafe"),
    ("werkzeug", "Werkzeug"),
    ("starlette", "starlette"),
    ("uvicorn", "uvicorn"),
    ("gunicorn", "gunicorn"),
    ("transformers", "transformers"),
    ("torch", "torch"),
    ("tensorflow", "tensorflow"),
    ("keras", "keras"),
];

// ── Packages excluded from "unused" detection (config/plugin packages) ─────

const JS_EXCLUDE_PREFIXES: &[&str] = &[
    "@types/",
    "eslint-config-",
    "eslint-plugin-",
    "babel-plugin-",
    "babel-preset-",
    "postcss-",
    "@postcss/",
    "prettier-plugin-",
    "typescript",
    "@eslint/",
    "stylelint-",
    "@babel/",
    "tslib",
];

// ── Directories to ignore when walking ─────────────────────────────────────

const IGNORE_DIRS: &[&str] = &[
    "node_modules", ".git", "dist", "build", ".next", "coverage",
    "__pycache__", ".venv", "venv", "env", ".tox", ".mypy_cache",
    ".pytest_cache", ".eggs", ".cargo", "target",
];

// ── Public API ──────────────────────────────────────────────────────────────

/// Analyze a project for missing and unused dependencies.
pub fn suggest_deps(project_root: &Path) -> Result<SuggestionReport, String> {
    let start = Instant::now();

    let has_npm = project_root.join("package.json").exists();
    let has_python = project_root.join("pyproject.toml").exists()
        || project_root.join("requirements.txt").exists()
        || project_root.join("setup.py").exists();

    let ecosystem = if has_npm && has_python {
        "polyglot"
    } else if has_npm {
        "npm"
    } else if has_python {
        "python"
    } else {
        return Err("No package.json, pyproject.toml, or requirements.txt found".to_string());
    };

    let mut missing = Vec::new();
    let mut unused = Vec::new();
    let mut total_files = 0usize;

    if has_npm {
        let (js_missing, js_unused, js_files) = analyze_js(project_root)?;
        missing.extend(js_missing);
        unused.extend(js_unused);
        total_files += js_files;
    }

    if has_python {
        let (py_missing, py_unused, py_files) = analyze_python(project_root)?;
        missing.extend(py_missing);
        unused.extend(py_unused);
        total_files += py_files;
    }

    Ok(SuggestionReport {
        missing,
        unused,
        ecosystem: ecosystem.to_string(),
        files_scanned: total_files,
        scan_ms: start.elapsed().as_millis() as u64,
    })
}

/// Write a SuggestionReport as JSON using the project's zero-dep JsonWriter.
pub fn write_suggest_json(report: &SuggestionReport) -> String {
    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("ok"); w.value_bool(true);
    w.key("kind"); w.value_string("better.suggest");
    w.key("ecosystem"); w.value_string(&report.ecosystem);
    w.key("filesScanned"); w.value_u64(report.files_scanned as u64);
    w.key("scanMs"); w.value_u64(report.scan_ms);

    w.key("missing"); w.begin_array();
    for dep in &report.missing {
        w.begin_object();
        w.key("name"); w.value_string(&dep.name);
        w.key("importStyle"); w.value_string(&dep.import_style);
        w.key("confidence"); w.value_f64(dep.confidence);
        w.key("importedIn"); w.begin_array();
        for f in &dep.imported_in {
            w.value_string(f);
        }
        w.end_array();
        w.end_object();
    }
    w.end_array();

    w.key("unused"); w.begin_array();
    for dep in &report.unused {
        w.begin_object();
        w.key("name"); w.value_string(&dep.name);
        w.key("declaredIn"); w.value_string(&dep.declared_in);
        w.key("version"); w.value_string(&dep.version);
        w.key("confidence"); w.value_f64(dep.confidence);
        w.end_object();
    }
    w.end_array();

    w.key("summary"); w.begin_object();
    w.key("missingCount"); w.value_u64(report.missing.len() as u64);
    w.key("unusedCount"); w.value_u64(report.unused.len() as u64);
    w.end_object();

    w.end_object();
    w.out.push('\n');
    w.finish()
}

// ── JS/TS analysis ──────────────────────────────────────────────────────────

fn analyze_js(project_root: &Path) -> Result<(Vec<MissingDep>, Vec<UnusedDep>, usize), String> {
    let pkg_json_path = project_root.join("package.json");
    let pkg_content = fs::read_to_string(&pkg_json_path)
        .map_err(|e| format!("Failed to read package.json: {}", e))?;

    let deps = extract_json_object_pairs(&pkg_content, "dependencies").unwrap_or_default();
    let dev_deps = extract_json_object_pairs(&pkg_content, "devDependencies").unwrap_or_default();
    let scripts = extract_json_object_pairs(&pkg_content, "scripts").unwrap_or_default();

    let deps_map: HashMap<String, String> = deps.into_iter().collect();
    let dev_deps_map: HashMap<String, String> = dev_deps.into_iter().collect();

    // All declared deps
    let mut declared: HashMap<String, (String, &str)> = HashMap::new();
    for (name, version) in &deps_map {
        declared.insert(name.clone(), (version.clone(), "dependencies"));
    }
    for (name, version) in &dev_deps_map {
        declared.insert(name.clone(), (version.clone(), "devDependencies"));
    }

    let builtins: HashSet<&str> = NODE_BUILTINS.iter().copied().collect();

    // Scan imports with file tracking
    let (imports_by_pkg, files_scanned) = scan_js_imports_with_files(project_root);

    // Script references for confidence adjustment
    let script_refs: HashSet<String> = scripts
        .iter()
        .flat_map(|(_, cmd)| extract_package_refs_from_script(cmd))
        .collect();

    // Find missing
    let mut missing = Vec::new();
    for (pkg_name, files) in &imports_by_pkg {
        if builtins.contains(pkg_name.as_str()) {
            continue;
        }
        // Skip node: prefixed builtins
        if pkg_name.starts_with("node:") {
            continue;
        }
        if declared.contains_key(pkg_name) {
            continue;
        }
        missing.push(MissingDep {
            name: pkg_name.clone(),
            imported_in: files.iter().cloned().collect(),
            import_style: "import".to_string(),
            confidence: 0.9,
        });
    }

    // Find unused
    let imported_pkgs: HashSet<&String> = imports_by_pkg.keys().collect();
    let mut unused_deps = Vec::new();
    for (name, (version, section)) in &declared {
        if JS_EXCLUDE_PREFIXES.iter().any(|p| name.starts_with(p)) {
            continue;
        }
        if imported_pkgs.contains(name) {
            continue;
        }
        let in_scripts = script_refs.contains(name);
        let confidence = if in_scripts { 0.5 } else { 0.7 };
        unused_deps.push(UnusedDep {
            name: name.clone(),
            declared_in: section.to_string(),
            version: version.clone(),
            confidence,
        });
    }

    missing.sort_by(|a, b| a.name.cmp(&b.name));
    unused_deps.sort_by(|a, b| a.name.cmp(&b.name));

    Ok((missing, unused_deps, files_scanned))
}

/// Scan JS/TS files and return a map of package_name -> set of files that import it.
fn scan_js_imports_with_files(project_root: &Path) -> (HashMap<String, HashSet<String>>, usize) {
    let mut pkg_files: HashMap<String, HashSet<String>> = HashMap::new();
    let extensions: &[&str] = &["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"];

    let scan_dirs = ["src", "lib", "app", "pages", "components", "server", "scripts"];
    let mut files_to_scan = Vec::new();

    for dir in &scan_dirs {
        let dir_path = project_root.join(dir);
        if dir_path.is_dir() {
            walk_dir(&dir_path, extensions, &mut files_to_scan);
        }
    }

    // Root-level files
    if let Ok(entries) = fs::read_dir(project_root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    if extensions.contains(&ext) {
                        files_to_scan.push(path);
                    }
                }
            }
        }
    }

    let file_count = files_to_scan.len();

    for file in &files_to_scan {
        if let Ok(content) = fs::read_to_string(file) {
            let mut packages = HashSet::new();
            extract_imports_from_js(&content, &mut packages);
            let rel = file.strip_prefix(project_root)
                .unwrap_or(file)
                .to_string_lossy()
                .to_string();
            for pkg in packages {
                pkg_files.entry(pkg).or_default().insert(rel.clone());
            }
        }
    }

    (pkg_files, file_count)
}

/// Extract import specifiers from JS/TS content.
fn extract_imports_from_js(content: &str, packages: &mut HashSet<String>) {
    let bytes = content.as_bytes();
    let len = bytes.len();
    let mut i = 0;

    while i < len {
        // Skip single-line comments
        if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'/' {
            while i < len && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        // Skip multi-line comments
        if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < len && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i += 2;
            continue;
        }
        // Skip template literals
        if bytes[i] == b'`' {
            i += 1;
            while i < len && bytes[i] != b'`' {
                if bytes[i] == b'\\' { i += 1; }
                i += 1;
            }
            i += 1;
            continue;
        }

        // 'from' keyword (import/export ... from 'specifier')
        if i + 4 < len
            && &bytes[i..i + 4] == b"from"
            && !is_ident_char(bytes.get(i + 4).copied())
            && (i == 0 || !is_ident_char(Some(bytes[i - 1])))
        {
            i += 4;
            while i < len && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            if let Some((spec, end)) = extract_string_literal(bytes, i) {
                if let Some(pkg) = normalize_js_package(&spec) {
                    packages.insert(pkg);
                }
                i = end;
                continue;
            }
        }

        // require('specifier') or import('specifier')
        if (i + 7 < len && &bytes[i..i + 7] == b"require" && !is_ident_char(bytes.get(i.wrapping_sub(1)).copied()))
            || (i + 6 < len && &bytes[i..i + 6] == b"import" && !is_ident_char(bytes.get(i.wrapping_sub(1)).copied()))
        {
            let keyword_len = if bytes[i] == b'r' { 7 } else { 6 };
            let mut j = i + keyword_len;
            while j < len && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < len && bytes[j] == b'(' {
                j += 1;
                while j < len && bytes[j].is_ascii_whitespace() {
                    j += 1;
                }
                if let Some((spec, end)) = extract_string_literal(bytes, j) {
                    if let Some(pkg) = normalize_js_package(&spec) {
                        packages.insert(pkg);
                    }
                    i = end;
                    continue;
                }
            }
        }

        i += 1;
    }
}

// ── Python analysis ─────────────────────────────────────────────────────────

fn analyze_python(project_root: &Path) -> Result<(Vec<MissingDep>, Vec<UnusedDep>, usize), String> {
    let declared = read_python_declared_deps(project_root)?;
    let stdlib: HashSet<&str> = PYTHON_STDLIB.iter().copied().collect();
    let import_map: HashMap<&str, &str> = PYTHON_IMPORT_TO_PACKAGE.iter().copied().collect();

    // Reverse map: PyPI name -> import name
    let reverse_map: HashMap<&str, &str> = PYTHON_IMPORT_TO_PACKAGE
        .iter()
        .map(|(imp, pkg)| (*pkg, *imp))
        .collect();

    let (imports_by_pkg, files_scanned) = scan_python_imports_with_files(project_root);

    // Normalize declared dep names for comparison (lowercase, replace - with _)
    let declared_normalized: HashSet<String> = declared
        .iter()
        .map(|(name, _)| normalize_python_name(name))
        .collect();

    let mut missing = Vec::new();
    for (import_name, files) in &imports_by_pkg {
        if stdlib.contains(import_name.as_str()) {
            continue;
        }
        if import_name.starts_with('.') {
            continue;
        }

        // Map import name to package name
        let package_name = import_map
            .get(import_name.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| import_name.clone());

        let normalized = normalize_python_name(&package_name);
        let normalized_import = normalize_python_name(import_name);

        if declared_normalized.contains(&normalized)
            || declared_normalized.contains(&normalized_import)
        {
            continue;
        }

        missing.push(MissingDep {
            name: package_name,
            imported_in: files.iter().cloned().collect(),
            import_style: "import".to_string(),
            confidence: 0.85,
        });
    }

    // Find unused
    let imported_raw: HashSet<String> = imports_by_pkg.keys().cloned().collect();
    let imported_normalized: HashSet<String> = imported_raw
        .iter()
        .map(|s| normalize_python_name(s))
        .collect();

    let mut unused_deps = Vec::new();
    for (name, version) in &declared {
        let normalized = normalize_python_name(name);

        if imported_normalized.contains(&normalized) {
            continue;
        }

        // Check via reverse mapping (PyPI name -> import name)
        if let Some(import_name) = reverse_map.get(name.as_str()) {
            if imported_raw.contains(*import_name) {
                continue;
            }
        }

        // Also check with dashes replaced by underscores
        let as_import = name.replace('-', "_").to_lowercase();
        if imported_normalized.contains(&as_import) {
            continue;
        }

        unused_deps.push(UnusedDep {
            name: name.clone(),
            declared_in: "dependencies".to_string(),
            version: version.clone(),
            confidence: 0.7,
        });
    }

    missing.sort_by(|a, b| a.name.cmp(&b.name));
    unused_deps.sort_by(|a, b| a.name.cmp(&b.name));

    Ok((missing, unused_deps, files_scanned))
}

/// Read declared dependencies from pyproject.toml or requirements.txt.
fn read_python_declared_deps(project_root: &Path) -> Result<Vec<(String, String)>, String> {
    let mut deps = Vec::new();

    let pyproject_path = project_root.join("pyproject.toml");
    if pyproject_path.exists() {
        let content = fs::read_to_string(&pyproject_path)
            .map_err(|e| format!("Failed to read pyproject.toml: {}", e))?;
        deps.extend(parse_pyproject_deps(&content));
    }

    let req_path = project_root.join("requirements.txt");
    if req_path.exists() {
        let content = fs::read_to_string(&req_path)
            .map_err(|e| format!("Failed to read requirements.txt: {}", e))?;
        deps.extend(parse_requirements_txt(&content));
    }

    Ok(deps)
}

/// Parse dependencies from pyproject.toml [project].dependencies array.
fn parse_pyproject_deps(content: &str) -> Vec<(String, String)> {
    let project_section = match content.find("[project]") {
        Some(pos) => &content[pos..],
        None => return Vec::new(),
    };

    let section_end = project_section[1..]
        .find("\n[")
        .map(|p| p + 1)
        .unwrap_or(project_section.len());
    let section = &project_section[..section_end];

    let deps_start = match section.find("dependencies") {
        Some(pos) => pos,
        None => return Vec::new(),
    };
    let after = &section[deps_start..];
    let bracket_start = match after.find('[') {
        Some(pos) => pos,
        None => return Vec::new(),
    };
    let bracket_content = &after[bracket_start..];
    let bracket_end = match bracket_content.find(']') {
        Some(pos) => pos,
        None => return Vec::new(),
    };
    let inside = &bracket_content[1..bracket_end];

    let mut deps = Vec::new();
    for line in inside.lines() {
        let trimmed = line.trim().trim_matches(',').trim().trim_matches('"').trim_matches('\'').trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let (name, version) = parse_dep_specifier(trimmed);
        if !name.is_empty() {
            deps.push((name, version));
        }
    }
    deps
}

/// Parse a requirements.txt file into (name, version_spec) pairs.
fn parse_requirements_txt(content: &str) -> Vec<(String, String)> {
    let mut deps = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('-') {
            continue;
        }
        let (name, version) = parse_dep_specifier(trimmed);
        if !name.is_empty() {
            deps.push((name, version));
        }
    }
    deps
}

/// Parse "package>=1.0,<2.0" or "package==1.0" into (name, version).
fn parse_dep_specifier(spec: &str) -> (String, String) {
    let spec = spec.split(';').next().unwrap_or(spec).trim();

    let name_end = spec
        .find(|c: char| c == '>' || c == '<' || c == '=' || c == '!' || c == '~')
        .unwrap_or(spec.len());

    let mut name = spec[..name_end].trim().to_string();
    let version = spec[name_end..].trim().to_string();

    // Strip extras like [dev,test]
    if let Some(bracket) = name.find('[') {
        name = name[..bracket].to_string();
    }

    (name.trim().to_string(), version)
}

/// Scan Python files and return a map of import_name -> set of files.
fn scan_python_imports_with_files(project_root: &Path) -> (HashMap<String, HashSet<String>>, usize) {
    let mut pkg_files: HashMap<String, HashSet<String>> = HashMap::new();
    let extensions: &[&str] = &["py"];

    let mut files_to_scan = Vec::new();
    walk_dir(project_root, extensions, &mut files_to_scan);

    let file_count = files_to_scan.len();

    for file in &files_to_scan {
        if let Ok(content) = fs::read_to_string(file) {
            let mut imports = HashSet::new();
            extract_imports_from_python(&content, &mut imports);
            let rel = file.strip_prefix(project_root)
                .unwrap_or(file)
                .to_string_lossy()
                .to_string();
            for imp in imports {
                pkg_files.entry(imp).or_default().insert(rel.clone());
            }
        }
    }

    (pkg_files, file_count)
}

/// Extract top-level import names from Python source.
fn extract_imports_from_python(content: &str, imports: &mut HashSet<String>) {
    for line in content.lines() {
        let trimmed = line.trim();

        if trimmed.starts_with('#') {
            continue;
        }

        // import X, Y, Z  or  import X as Y
        if trimmed.starts_with("import ") && !trimmed.starts_with("import (") {
            let rest = &trimmed["import ".len()..];
            for module in rest.split(',') {
                let module = module.trim().split(" as ").next().unwrap_or("").trim();
                if !module.is_empty() && !module.starts_with('.') {
                    imports.insert(top_level_module(module));
                }
            }
            continue;
        }

        // from X import Y
        if trimmed.starts_with("from ") && trimmed.contains(" import ") {
            let rest = &trimmed["from ".len()..];
            if let Some((module, _)) = rest.split_once(" import ") {
                let module = module.trim();
                if !module.starts_with('.') && !module.is_empty() {
                    imports.insert(top_level_module(module));
                }
            }
        }
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn top_level_module(module: &str) -> String {
    module.split('.').next().unwrap_or(module).to_string()
}

fn normalize_python_name(name: &str) -> String {
    name.to_lowercase().replace('-', "_").replace('.', "_")
}

/// Normalize a JS import specifier to a package name.
fn normalize_js_package(spec: &str) -> Option<String> {
    if spec.starts_with('.') || spec.starts_with('/') {
        return None;
    }
    if spec.starts_with('@') {
        let parts: Vec<&str> = spec.splitn(3, '/').collect();
        if parts.len() >= 2 {
            Some(format!("{}/{}", parts[0], parts[1]))
        } else {
            None
        }
    } else {
        Some(spec.split('/').next().unwrap_or(spec).to_string())
    }
}

fn is_ident_char(ch: Option<u8>) -> bool {
    match ch {
        Some(c) => c.is_ascii_alphanumeric() || c == b'_' || c == b'$',
        None => false,
    }
}

fn extract_string_literal(bytes: &[u8], i: usize) -> Option<(String, usize)> {
    if i >= bytes.len() {
        return None;
    }
    let quote = bytes[i];
    if quote != b'\'' && quote != b'"' {
        return None;
    }
    let mut j = i + 1;
    let mut s = String::new();
    while j < bytes.len() {
        if bytes[j] == b'\\' {
            j += 2;
            continue;
        }
        if bytes[j] == quote {
            return Some((s, j + 1));
        }
        s.push(bytes[j] as char);
        j += 1;
    }
    None
}

fn extract_package_refs_from_script(cmd: &str) -> Vec<String> {
    cmd.split_whitespace()
        .filter(|w| !w.starts_with('-') && !w.starts_with('/') && !w.starts_with('.'))
        .filter(|w| !["&&", "||", "|", ";", "npx", "node", "better", "npm", "pnpm", "yarn"].contains(w))
        .map(|w| w.to_string())
        .collect()
}

fn walk_dir(dir: &Path, extensions: &[&str], files: &mut Vec<PathBuf>) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if IGNORE_DIRS.contains(&name) || name.starts_with('.') {
                    continue;
                }
                walk_dir(&path, extensions, files);
            } else if path.is_file() {
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    if extensions.contains(&ext) {
                        files.push(path);
                    }
                }
            }
        }
    }
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_js_package() {
        assert_eq!(normalize_js_package("lodash"), Some("lodash".into()));
        assert_eq!(normalize_js_package("lodash/fp"), Some("lodash".into()));
        assert_eq!(normalize_js_package("@scope/pkg"), Some("@scope/pkg".into()));
        assert_eq!(normalize_js_package("@scope/pkg/deep"), Some("@scope/pkg".into()));
        assert_eq!(normalize_js_package("./local"), None);
        assert_eq!(normalize_js_package("/absolute"), None);
    }

    #[test]
    fn test_extract_imports_from_js() {
        let mut pkgs = HashSet::new();
        let content = r#"
import lodash from "lodash";
import { merge } from 'lodash/merge';
const express = require('express');
const path = require("path");
import("chalk").then(m => m.default);
export { foo } from '@scope/pkg';
// import ignored from "commented-out";
/* import also from "block-comment"; */
import relative from "./local";
import nodeFs from "node:fs";
        "#;
        extract_imports_from_js(content, &mut pkgs);

        assert!(pkgs.contains("lodash"));
        assert!(pkgs.contains("express"));
        assert!(pkgs.contains("path"));
        assert!(pkgs.contains("chalk"));
        assert!(pkgs.contains("@scope/pkg"));
        assert!(!pkgs.contains("commented-out"));
        assert!(!pkgs.contains("block-comment"));
        assert!(!pkgs.contains("./local"));
        assert!(pkgs.contains("node:fs"));
    }

    #[test]
    fn test_extract_imports_from_python() {
        let mut imports = HashSet::new();
        let content = "
import os
import json
import requests
from flask import Flask
from PIL import Image
import numpy as np
from .local import something
# import commented
from collections import OrderedDict
import pandas, scipy
from sklearn.model_selection import train_test_split
";
        extract_imports_from_python(content, &mut imports);

        assert!(imports.contains("os"));
        assert!(imports.contains("json"));
        assert!(imports.contains("requests"));
        assert!(imports.contains("flask"));
        assert!(imports.contains("PIL"));
        assert!(imports.contains("numpy"));
        assert!(imports.contains("collections"));
        assert!(imports.contains("pandas"));
        assert!(imports.contains("scipy"));
        assert!(imports.contains("sklearn"));
        assert!(!imports.contains("something"));
        assert!(!imports.contains("commented"));
    }

    #[test]
    fn test_parse_dep_specifier() {
        assert_eq!(parse_dep_specifier("requests>=2.28"), ("requests".into(), ">=2.28".into()));
        assert_eq!(parse_dep_specifier("flask==2.3.0"), ("flask".into(), "==2.3.0".into()));
        assert_eq!(parse_dep_specifier("numpy"), ("numpy".into(), "".into()));
        assert_eq!(parse_dep_specifier("black[jupyter]>=23.0"), ("black".into(), ">=23.0".into()));
        assert_eq!(parse_dep_specifier("pytz; python_version < '3.9'"), ("pytz".into(), "".into()));
    }

    #[test]
    fn test_parse_pyproject_deps() {
        let content = r#"
[project]
name = "myproject"
version = "0.1.0"
dependencies = [
    "requests>=2.28",
    "flask==2.3.0",
    "numpy",
]

[tool.pytest]
"#;
        let deps = parse_pyproject_deps(content);
        assert_eq!(deps.len(), 3);
        assert_eq!(deps[0].0, "requests");
        assert_eq!(deps[1].0, "flask");
        assert_eq!(deps[2].0, "numpy");
    }

    #[test]
    fn test_parse_requirements_txt() {
        let content = "
# Core deps
requests>=2.28
flask==2.3.0
numpy
-r dev-requirements.txt
--find-links /path
";
        let deps = parse_requirements_txt(content);
        assert_eq!(deps.len(), 3);
        assert_eq!(deps[0].0, "requests");
        assert_eq!(deps[1].0, "flask");
        assert_eq!(deps[2].0, "numpy");
    }

    #[test]
    fn test_normalize_python_name() {
        assert_eq!(normalize_python_name("scikit-learn"), "scikit_learn");
        assert_eq!(normalize_python_name("PyYAML"), "pyyaml");
        assert_eq!(normalize_python_name("python-dotenv"), "python_dotenv");
    }
}
