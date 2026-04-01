use std::fs;
use std::path::Path;

use crate::types::InitResult;
use crate::JsonWriter;

// --- C.5: Init ---

const TEMPLATE_TSCONFIG: &str = r#"{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "jsx": "react-jsx"
  },
  "include": ["src"]
}
"#;

const TEMPLATE_GITIGNORE: &str = "node_modules/\ndist/\n.env\n.env.local\n*.log\ncoverage/\n.DS_Store\n";

const TEMPLATE_REACT_APP: &str = r#"import { useState } from 'react';

export default function App() {
  const [count, setCount] = useState(0);

  return (
    <div style={{ padding: '2rem', fontFamily: 'system-ui' }}>
      <h1>Hello from Better</h1>
      <button onClick={() => setCount(c => c + 1)}>
        Count: {count}
      </button>
    </div>
  );
}
"#;

const TEMPLATE_NEXT_PAGE: &str = r#"export default function Home() {
  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui' }}>
      <h1>Hello from Better + Next.js</h1>
      <p>Edit <code>src/app/page.tsx</code> to get started.</p>
    </main>
  );
}
"#;

const TEMPLATE_EXPRESS_APP: &str = r#"import express from 'express';

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

app.get('/', (_req, res) => {
  res.json({ message: 'Hello from Better + Express' });
});

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
"#;

fn write_file(root: &Path, rel: &str, content: &str, files: &mut Vec<String>) -> Result<(), String> {
    let path = root.join(rel);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, content).map_err(|e| format!("Failed to write {}: {}", rel, e))?;
    files.push(rel.to_string());
    Ok(())
}

fn write_react_template(root: &Path, name: &str) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("name"); w.value_string(name);
    w.key("version"); w.value_string("0.1.0");
    w.key("private"); w.value_bool(true);
    w.key("type"); w.value_string("module");
    w.key("scripts"); w.begin_object();
    w.key("dev"); w.value_string("vite");
    w.key("build"); w.value_string("tsc && vite build");
    w.key("preview"); w.value_string("vite preview");
    w.end_object();
    w.key("dependencies"); w.begin_object();
    w.key("react"); w.value_string("^18.3.0");
    w.key("react-dom"); w.value_string("^18.3.0");
    w.end_object();
    w.key("devDependencies"); w.begin_object();
    w.key("@types/react"); w.value_string("^18.3.0");
    w.key("@types/react-dom"); w.value_string("^18.3.0");
    w.key("@vitejs/plugin-react"); w.value_string("^4.0.0");
    w.key("typescript"); w.value_string("^5.0.0");
    w.key("vite"); w.value_string("^5.0.0");
    w.end_object();
    w.end_object(); w.out.push('\n');
    write_file(root, "package.json", &w.finish(), &mut files)?;
    write_file(root, "tsconfig.json", TEMPLATE_TSCONFIG, &mut files)?;
    write_file(root, ".gitignore", TEMPLATE_GITIGNORE, &mut files)?;
    write_file(root, "src/App.tsx", TEMPLATE_REACT_APP, &mut files)?;
    Ok(files)
}

fn write_next_template(root: &Path, name: &str) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("name"); w.value_string(name);
    w.key("version"); w.value_string("0.1.0");
    w.key("private"); w.value_bool(true);
    w.key("scripts"); w.begin_object();
    w.key("dev"); w.value_string("next dev");
    w.key("build"); w.value_string("next build");
    w.key("start"); w.value_string("next start");
    w.end_object();
    w.key("dependencies"); w.begin_object();
    w.key("next"); w.value_string("^14.0.0");
    w.key("react"); w.value_string("^18.3.0");
    w.key("react-dom"); w.value_string("^18.3.0");
    w.end_object();
    w.key("devDependencies"); w.begin_object();
    w.key("@types/react"); w.value_string("^18.3.0");
    w.key("typescript"); w.value_string("^5.0.0");
    w.end_object();
    w.end_object(); w.out.push('\n');
    write_file(root, "package.json", &w.finish(), &mut files)?;
    write_file(root, "tsconfig.json", TEMPLATE_TSCONFIG, &mut files)?;
    write_file(root, ".gitignore", TEMPLATE_GITIGNORE, &mut files)?;
    write_file(root, "src/app/page.tsx", TEMPLATE_NEXT_PAGE, &mut files)?;
    Ok(files)
}

fn write_express_template(root: &Path, name: &str) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("name"); w.value_string(name);
    w.key("version"); w.value_string("0.1.0");
    w.key("private"); w.value_bool(true);
    w.key("type"); w.value_string("module");
    w.key("scripts"); w.begin_object();
    w.key("dev"); w.value_string("tsx watch src/app.ts");
    w.key("build"); w.value_string("tsc");
    w.key("start"); w.value_string("node dist/app.js");
    w.end_object();
    w.key("dependencies"); w.begin_object();
    w.key("express"); w.value_string("^4.18.0");
    w.end_object();
    w.key("devDependencies"); w.begin_object();
    w.key("@types/express"); w.value_string("^4.17.0");
    w.key("tsx"); w.value_string("^4.0.0");
    w.key("typescript"); w.value_string("^5.0.0");
    w.end_object();
    w.end_object(); w.out.push('\n');
    write_file(root, "package.json", &w.finish(), &mut files)?;
    write_file(root, "tsconfig.json", TEMPLATE_TSCONFIG, &mut files)?;
    write_file(root, ".gitignore", TEMPLATE_GITIGNORE, &mut files)?;
    write_file(root, "src/app.ts", TEMPLATE_EXPRESS_APP, &mut files)?;
    Ok(files)
}

pub fn init_project(project_root: &Path, name: Option<&str>, template: Option<&str>) -> Result<InitResult, String> {
    fs::create_dir_all(project_root).map_err(|e| e.to_string())?;

    let pkg_json = project_root.join("package.json");
    if pkg_json.exists() {
        return Err("package.json already exists".to_string());
    }

    let project_name = name.map(|s| s.to_string()).unwrap_or_else(|| {
        project_root.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "my-project".to_string())
    });

    if let Some(tmpl) = template {
        let files = match tmpl {
            "react" => write_react_template(project_root, &project_name)?,
            "next" => write_next_template(project_root, &project_name)?,
            "express" => write_express_template(project_root, &project_name)?,
            _ => return Err(format!("Unknown template '{}'. Available: react, next, express", tmpl)),
        };
        return Ok(InitResult { files_created: files, template: Some(tmpl.to_string()) });
    }

    // Default init (no template)
    let mut files = Vec::new();
    let mut w = JsonWriter::new();
    w.begin_object();
    w.key("name"); w.value_string(&project_name);
    w.key("version"); w.value_string("1.0.0");
    w.key("description"); w.value_string("");
    w.key("main"); w.value_string("index.js");
    w.key("scripts"); w.begin_object();
    w.key("test"); w.value_string("echo \"Error: no test specified\" && exit 1");
    w.end_object();
    w.key("keywords"); w.begin_array(); w.end_array();
    w.key("author"); w.value_string("");
    w.key("license"); w.value_string("ISC");
    w.end_object(); w.out.push('\n');

    fs::write(&pkg_json, w.finish()).map_err(|e| e.to_string())?;
    files.push("package.json".to_string());

    Ok(InitResult { files_created: files, template: None })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_init_creates_package_json() {
        let tmp = std::env::temp_dir().join("init-test-default");
        let _ = std::fs::remove_dir_all(&tmp);
        let result = init_project(&tmp, None, None).unwrap();
        assert!(result.files_created.contains(&"package.json".to_string()));
        assert!(result.template.is_none());
        assert!(tmp.join("package.json").exists());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn custom_name_written_to_package_json() {
        let tmp = std::env::temp_dir().join("init-test-named");
        let _ = std::fs::remove_dir_all(&tmp);
        init_project(&tmp, Some("my-app"), None).unwrap();
        let content = std::fs::read_to_string(tmp.join("package.json")).unwrap();
        assert!(content.contains("\"my-app\""));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn existing_package_json_returns_error() {
        let tmp = std::env::temp_dir().join("init-test-exists");
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("package.json"), "{}").unwrap();
        let result = init_project(&tmp, None, None);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("already exists"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn react_template_creates_expected_files() {
        let tmp = std::env::temp_dir().join("init-test-react");
        let _ = std::fs::remove_dir_all(&tmp);
        let result = init_project(&tmp, Some("my-react-app"), Some("react")).unwrap();
        assert_eq!(result.template, Some("react".to_string()));
        assert!(result.files_created.iter().any(|f| f == "src/App.tsx"));
        assert!(result.files_created.iter().any(|f| f == "tsconfig.json"));
        assert!(result.files_created.iter().any(|f| f == ".gitignore"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn unknown_template_returns_error() {
        let tmp = std::env::temp_dir().join("init-test-unknown-tmpl");
        let _ = std::fs::remove_dir_all(&tmp);
        let result = init_project(&tmp, None, Some("angular"));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unknown template"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn next_template_has_next_dependency() {
        let tmp = std::env::temp_dir().join("init-test-next");
        let _ = std::fs::remove_dir_all(&tmp);
        init_project(&tmp, Some("my-next-app"), Some("next")).unwrap();
        let content = std::fs::read_to_string(tmp.join("package.json")).unwrap();
        assert!(content.contains("\"next\""));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
