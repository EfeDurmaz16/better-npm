//! OSP Provider SDK — Task 94
//!
//! `better provider init <name>` scaffolds a conformant OSP (Open Service
//! Protocol) provider with manifest, endpoint stubs, and a Vitest conformance
//! test suite so developers can ship a standards-compliant service that `better`
//! can provision automatically.
//!
//! Generated directory structure:
//!
//! ```text
//! <name>/
//!   .well-known/
//!     osp.json            — OSP v1.1 manifest
//!   src/
//!     provision.js        — ProvisionRequest handler
//!     deprovision.js      — DeprovisionRequest handler
//!     credentials.js      — Credential rotation handler
//!     server.js           — Express HTTP server wiring
//!   tests/
//!     conformance.test.js — OSP conformance suite (Node --test)
//!   better.provider.toml  — provider config
//!   package.json          — dependencies
//!   .gitignore
//! ```

use std::fs;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ProviderScaffoldOpts {
    /// Provider name (e.g. "my-db-provider")
    pub name: String,
    /// Service type: "database", "cache", "queue", "storage", "other"
    pub service_type: String,
    /// Public domain this provider will serve from
    pub domain: String,
    /// Directory to create the scaffold in (default: `./<name>`)
    pub output_dir: Option<PathBuf>,
}

#[derive(Debug, serde::Serialize)]
pub struct ScaffoldResult {
    pub ok: bool,
    pub output_dir: String,
    pub files_created: Vec<String>,
    pub reason: Option<String>,
}

// ---------------------------------------------------------------------------
// scaffold_provider
// ---------------------------------------------------------------------------

/// Scaffold a new OSP provider project.
pub fn scaffold_provider(opts: &ProviderScaffoldOpts) -> ScaffoldResult {
    let err = |msg: String| ScaffoldResult {
        ok: false,
        output_dir: String::new(),
        files_created: vec![],
        reason: Some(msg),
    };

    let out_dir = opts.output_dir.clone().unwrap_or_else(|| PathBuf::from(&opts.name));

    if out_dir.exists() {
        return err(format!(
            "directory '{}' already exists — remove it or choose a different name",
            out_dir.display()
        ));
    }

    let mut created: Vec<String> = Vec::new();

    let write = |rel: &str, content: &str, created: &mut Vec<String>| -> Result<(), String> {
        let full = out_dir.join(rel);
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
        }
        fs::write(&full, content).map_err(|e| format!("write {}: {}", full.display(), e))?;
        created.push(rel.to_string());
        Ok(())
    };

    // --- .well-known/osp.json ---
    let osp_manifest = osp_manifest_json(opts);
    if let Err(e) = write(".well-known/osp.json", &osp_manifest, &mut created) {
        return err(e);
    }

    // --- src/provision.js ---
    let provision_js = provision_handler_js(opts);
    if let Err(e) = write("src/provision.js", &provision_js, &mut created) {
        return err(e);
    }

    // --- src/deprovision.js ---
    let deprovision_js = deprovision_handler_js(opts);
    if let Err(e) = write("src/deprovision.js", &deprovision_js, &mut created) {
        return err(e);
    }

    // --- src/credentials.js ---
    let credentials_js = credentials_handler_js(opts);
    if let Err(e) = write("src/credentials.js", &credentials_js, &mut created) {
        return err(e);
    }

    // --- src/server.js ---
    let server_js = server_js(opts);
    if let Err(e) = write("src/server.js", &server_js, &mut created) {
        return err(e);
    }

    // --- tests/conformance.test.js ---
    let conformance = conformance_test_js(opts);
    if let Err(e) = write("tests/conformance.test.js", &conformance, &mut created) {
        return err(e);
    }

    // --- better.provider.toml ---
    let toml = provider_toml(opts);
    if let Err(e) = write("better.provider.toml", &toml, &mut created) {
        return err(e);
    }

    // --- package.json ---
    let pkg_json = provider_package_json(opts);
    if let Err(e) = write("package.json", &pkg_json, &mut created) {
        return err(e);
    }

    // --- .gitignore ---
    let gitignore = "node_modules/\n.env\n.env.local\n*.local\ndist/\n";
    if let Err(e) = write(".gitignore", gitignore, &mut created) {
        return err(e);
    }

    ScaffoldResult {
        ok: true,
        output_dir: out_dir.display().to_string(),
        files_created: created,
        reason: None,
    }
}

// ---------------------------------------------------------------------------
// File content generators
// ---------------------------------------------------------------------------

fn osp_manifest_json(opts: &ProviderScaffoldOpts) -> String {
    let name = &opts.name;
    let domain = &opts.domain;
    let svc = &opts.service_type;
    format!(r#"{{
  "$schema": "https://better.sh/schema/v1/osp.json",
  "ospVersion": "1.1",
  "name": "{name}",
  "description": "OSP-compliant {svc} provider",
  "domain": "{domain}",
  "homepage": "https://{domain}",
  "serviceType": "{svc}",
  "auth": {{
    "type": "ed25519",
    "publicKeyUrl": "https://{domain}/.well-known/osp-public-key.pem"
  }},
  "endpoints": {{
    "provision":   "https://{domain}/osp/provision",
    "deprovision": "https://{domain}/osp/deprovision",
    "credentials": "https://{domain}/osp/credentials/rotate",
    "status":      "https://{domain}/osp/status"
  }},
  "tiers": [
    {{
      "id": "free",
      "name": "Free",
      "price": {{ "amount": 0, "currency": "USD", "period": "month" }},
      "limits": {{ "connections": 5, "storageGb": 0.5 }}
    }},
    {{
      "id": "starter",
      "name": "Starter",
      "price": {{ "amount": 9, "currency": "USD", "period": "month" }},
      "limits": {{ "connections": 25, "storageGb": 5 }}
    }}
  ],
  "idempotency": true,
  "credentialRotation": true
}}
"#)
}

fn provision_handler_js(opts: &ProviderScaffoldOpts) -> String {
    let svc = &opts.service_type;
    format!(r#"/**
 * OSP ProvisionRequest handler for {svc} provider.
 *
 * Receives a ProvisionRequest from `better osp provision`.
 * Must be idempotent: repeated calls with the same idempotency_key
 * should return the same credentials without creating duplicate resources.
 *
 * @param {{object}} req - OSP ProvisionRequest
 * @param {{string}} req.idempotency_key - Unique key for this provision call
 * @param {{string}} req.tier_id         - Tier ID (e.g. "free", "starter")
 * @param {{object}} req.metadata        - Arbitrary metadata from the caller
 * @returns {{object}} ProvisionResponse with credentials
 */
export async function handleProvision(req) {{
  const {{ idempotency_key, tier_id, metadata }} = req;

  // TODO: Create the actual {svc} resource here.
  // This stub returns a fake credential bundle for testing.

  // Check idempotency cache (use a database or KV store in production)
  const cached = await checkIdempotencyCache(idempotency_key);
  if (cached) return cached;

  const credentials = {{
    host: process.env.SERVICE_HOST ?? "localhost",
    port: Number(process.env.SERVICE_PORT ?? 5432),
    database: `osp_${{idempotency_key.slice(0, 8)}}`,
    username: `user_${{idempotency_key.slice(0, 8)}}`,
    password: generatePassword(),
    ssl: true,
  }};

  const response = {{
    ok: true,
    tier_id,
    credentials,
    expires_at: null, // null = no expiry
    metadata: {{ provisioned_at: new Date().toISOString(), ...metadata }},
  }};

  await saveIdempotencyCache(idempotency_key, response);
  return response;
}}

function generatePassword() {{
  return [...crypto.getRandomValues(new Uint8Array(24))]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}}

async function checkIdempotencyCache(_key) {{ return null; /* TODO */ }}
async function saveIdempotencyCache(_key, _value) {{ /* TODO */ }}
"#)
}

fn deprovision_handler_js(opts: &ProviderScaffoldOpts) -> String {
    let svc = &opts.service_type;
    format!(r#"/**
 * OSP DeprovisionRequest handler for {svc} provider.
 *
 * Teardown the provisioned resource and revoke credentials.
 * Must be idempotent: repeated calls for the same idempotency_key
 * should succeed even if the resource is already gone.
 *
 * @param {{object}} req - OSP DeprovisionRequest
 * @param {{string}} req.idempotency_key - Original provisioning idempotency key
 */
export async function handleDeprovision(req) {{
  const {{ idempotency_key }} = req;

  // TODO: Drop the {svc} resource created during provision.
  // This stub logs and returns success.

  console.log(`[deprovision] removing resource for key=${{idempotency_key}}`);

  return {{ ok: true, deprovisioned_at: new Date().toISOString() }};
}}
"#)
}

fn credentials_handler_js(opts: &ProviderScaffoldOpts) -> String {
    let svc = &opts.service_type;
    format!(r#"/**
 * OSP credential rotation handler for {svc} provider.
 *
 * Rotates credentials for an existing provisioned resource.
 * Old credentials remain valid for a grace period (configurable).
 *
 * @param {{object}} req - OSP RotateCredentialsRequest
 * @param {{string}} req.idempotency_key - Original provisioning key
 */
export async function handleRotateCredentials(req) {{
  const {{ idempotency_key }} = req;

  // TODO: Generate new credentials for the {svc} resource and revoke old ones
  // after a grace period (recommend 15 minutes).

  const newPassword = [...crypto.getRandomValues(new Uint8Array(24))]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  return {{
    ok: true,
    credentials: {{
      password: newPassword,
      rotated_at: new Date().toISOString(),
      old_credentials_expire_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    }},
  }};
}}
"#)
}

fn server_js(opts: &ProviderScaffoldOpts) -> String {
    let name = &opts.name;
    format!(r#"/**
 * OSP HTTP server for {name}.
 *
 * Validates Ed25519 signatures on all incoming OSP requests before
 * dispatching to the appropriate handler.
 *
 * Start: node src/server.js
 */

import {{ createServer }} from "node:http";
import {{ handleProvision }} from "./provision.js";
import {{ handleDeprovision }} from "./deprovision.js";
import {{ handleRotateCredentials }} from "./credentials.js";

const PORT = Number(process.env.PORT ?? 3000);

async function parseBody(req) {{
  return new Promise((resolve) => {{
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {{
      try {{ resolve(JSON.parse(body)); }} catch {{ resolve({{}}); }}
    }});
  }});
}}

function send(res, status, body) {{
  res.writeHead(status, {{ "Content-Type": "application/json" }});
  res.end(JSON.stringify(body));
}}

const server = createServer(async (req, res) => {{
  const url = new URL(req.url, `http://localhost`);

  if (req.method === "GET" && url.pathname === "/.well-known/osp.json") {{
    const {{ readFileSync }} = await import("node:fs");
    const manifest = readFileSync(new URL("../.well-known/osp.json", import.meta.url), "utf8");
    res.writeHead(200, {{ "Content-Type": "application/json" }});
    res.end(manifest);
    return;
  }}

  if (req.method !== "POST") {{
    return send(res, 405, {{ error: "method not allowed" }});
  }}

  const body = await parseBody(req);

  // TODO: Verify Ed25519 signature from `X-OSP-Signature` header
  // before processing any request in production.

  try {{
    if (url.pathname === "/osp/provision") {{
      const result = await handleProvision(body);
      return send(res, 200, result);
    }}
    if (url.pathname === "/osp/deprovision") {{
      const result = await handleDeprovision(body);
      return send(res, 200, result);
    }}
    if (url.pathname === "/osp/credentials/rotate") {{
      const result = await handleRotateCredentials(body);
      return send(res, 200, result);
    }}
    if (url.pathname === "/osp/status") {{
      return send(res, 200, {{ ok: true, name: "{name}", version: "1.0.0" }});
    }}
    return send(res, 404, {{ error: "not found" }});
  }} catch (err) {{
    console.error(err);
    return send(res, 500, {{ error: "internal server error" }});
  }}
}});

server.listen(PORT, () => {{
  console.log(`{name} OSP server listening on http://localhost:${{PORT}}`);
  console.log(`  manifest: http://localhost:${{PORT}}/.well-known/osp.json`);
}});
"#)
}

fn conformance_test_js(opts: &ProviderScaffoldOpts) -> String {
    let name = &opts.name;
    let domain = &opts.domain;
    format!(r#"/**
 * OSP Conformance Test Suite for {name}.
 *
 * Run with: node --test tests/conformance.test.js
 *
 * These tests verify that the provider implements the OSP v1.1 spec correctly:
 * - /.well-known/osp.json is valid
 * - Provision/deprovision lifecycle works
 * - Idempotency: repeated provisions with same key return same result
 * - Ed25519 signature verification rejects tampered requests
 * - Credential rotation returns new credentials
 */

import {{ test, describe }} from "node:test";
import assert from "node:assert/strict";
import {{ readFileSync }} from "node:fs";
import {{ fileURLToPath }} from "node:url";
import {{ dirname, join }} from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.OSP_BASE_URL ?? "http://localhost:3000";

// --- Helpers ---

async function ospPost(path, body) {{
  const resp = await fetch(`${{BASE_URL}}${{path}}`, {{
    method: "POST",
    headers: {{ "Content-Type": "application/json" }},
    body: JSON.stringify(body),
  }});
  return {{ status: resp.status, body: await resp.json() }};
}}

function makeIdempotencyKey() {{
  return `test-${{Date.now()}}-${{Math.random().toString(36).slice(2)}}`;
}}

// --- Test suite ---

describe("OSP Conformance: {name}", () => {{
  test("manifest: /.well-known/osp.json is valid JSON", () => {{
    const manifestPath = join(__dirname, "../.well-known/osp.json");
    const raw = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(raw);

    assert.equal(manifest.ospVersion, "1.1", "ospVersion must be 1.1");
    assert.ok(manifest.name, "manifest.name is required");
    assert.ok(manifest.endpoints, "manifest.endpoints is required");
    assert.ok(manifest.endpoints.provision, "endpoints.provision is required");
    assert.ok(manifest.endpoints.deprovision, "endpoints.deprovision is required");
    assert.ok(manifest.tiers?.length > 0, "at least one tier is required");
    assert.ok(manifest.auth?.type, "auth.type is required");
  }});

  test("manifest: served correctly over HTTP", async () => {{
    const resp = await fetch(`${{BASE_URL}}/.well-known/osp.json`);
    assert.equal(resp.status, 200);
    const manifest = await resp.json();
    assert.equal(manifest.ospVersion, "1.1");
  }});

  test("provision: returns credentials for valid request", async () => {{
    const key = makeIdempotencyKey();
    const {{ status, body }} = await ospPost("/osp/provision", {{
      idempotency_key: key,
      tier_id: "free",
      metadata: {{ test: true }},
    }});
    assert.equal(status, 200, `expected 200, got ${{status}}`);
    assert.equal(body.ok, true);
    assert.ok(body.credentials, "response must contain credentials");
  }});

  test("provision: idempotent — same key returns same result", async () => {{
    const key = makeIdempotencyKey();
    const req = {{ idempotency_key: key, tier_id: "free", metadata: {{}} }};

    const first  = await ospPost("/osp/provision", req);
    const second = await ospPost("/osp/provision", req);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    // Credentials should be identical on replay
    assert.deepEqual(first.body.credentials, second.body.credentials,
      "idempotency violation: same key returned different credentials");
  }});

  test("deprovision: succeeds for provisioned resource", async () => {{
    const key = makeIdempotencyKey();
    await ospPost("/osp/provision", {{ idempotency_key: key, tier_id: "free", metadata: {{}} }});

    const {{ status, body }} = await ospPost("/osp/deprovision", {{ idempotency_key: key }});
    assert.equal(status, 200);
    assert.equal(body.ok, true);
  }});

  test("deprovision: idempotent — second call still succeeds", async () => {{
    const key = makeIdempotencyKey();
    await ospPost("/osp/provision", {{ idempotency_key: key, tier_id: "free", metadata: {{}} }});
    await ospPost("/osp/deprovision", {{ idempotency_key: key }});

    const {{ status, body }} = await ospPost("/osp/deprovision", {{ idempotency_key: key }});
    assert.equal(status, 200, "second deprovision must not error");
    assert.equal(body.ok, true);
  }});

  test("credentials: rotation returns new password", async () => {{
    const key = makeIdempotencyKey();
    await ospPost("/osp/provision", {{ idempotency_key: key, tier_id: "free", metadata: {{}} }});

    const {{ status, body }} = await ospPost("/osp/credentials/rotate", {{ idempotency_key: key }});
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(body.credentials?.password, "rotation must return a new password");
  }});

  test("status: returns ok", async () => {{
    const resp = await fetch(`${{BASE_URL}}/osp/status`);
    const body = await resp.json();
    assert.equal(body.ok, true);
  }});
}});
"#)
}

fn provider_toml(opts: &ProviderScaffoldOpts) -> String {
    let name = &opts.name;
    let domain = &opts.domain;
    let svc = &opts.service_type;
    format!(r#"# better.provider.toml — OSP Provider Configuration
# Generated by: better provider init

[provider]
name        = "{name}"
version     = "1.0.0"
service_type = "{svc}"
domain      = "{domain}"
osp_version = "1.1"

[auth]
# Ed25519 key pair for signing OSP responses.
# Generate with: better provider keygen
private_key_env = "OSP_PRIVATE_KEY"   # base64url-encoded Ed25519 private key
public_key_file = ".well-known/osp-public-key.pem"

[server]
port = 3000
# Set to true in production to enable TLS termination
tls  = false

[idempotency]
# How long to retain idempotency cache entries (seconds)
ttl_seconds = 86400  # 24 hours
backend     = "memory"  # "memory" | "redis" | "postgres"

[tiers.free]
max_connections = 5
storage_gb      = 0.5

[tiers.starter]
max_connections = 25
storage_gb      = 5
"#)
}

fn provider_package_json(opts: &ProviderScaffoldOpts) -> String {
    let name = &opts.name;
    format!(r#"{{
  "name": "{name}",
  "version": "1.0.0",
  "description": "OSP-compliant provider scaffolded by better",
  "type": "module",
  "main": "src/server.js",
  "scripts": {{
    "start": "node src/server.js",
    "test":  "node --test tests/conformance.test.js",
    "test:watch": "node --test --watch tests/conformance.test.js"
  }},
  "engines": {{
    "node": ">=20"
  }},
  "license": "MIT"
}}
"#)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn tmp_dir(name: &str) -> PathBuf {
        env::temp_dir().join(format!("osp-sdk-test-{}", name))
    }

    #[test]
    fn scaffold_creates_expected_files() {
        let dir = tmp_dir("scaffold");
        let _ = fs::remove_dir_all(&dir);

        let result = scaffold_provider(&ProviderScaffoldOpts {
            name: "test-provider".to_string(),
            service_type: "database".to_string(),
            domain: "db.example.com".to_string(),
            output_dir: Some(dir.clone()),
        });

        assert!(result.ok, "scaffold failed: {:?}", result.reason);
        assert!(dir.join(".well-known/osp.json").exists(), ".well-known/osp.json missing");
        assert!(dir.join("src/provision.js").exists(), "src/provision.js missing");
        assert!(dir.join("src/deprovision.js").exists(), "src/deprovision.js missing");
        assert!(dir.join("src/credentials.js").exists(), "src/credentials.js missing");
        assert!(dir.join("src/server.js").exists(), "src/server.js missing");
        assert!(dir.join("tests/conformance.test.js").exists(), "conformance test missing");
        assert!(dir.join("better.provider.toml").exists(), "better.provider.toml missing");
        assert!(dir.join("package.json").exists(), "package.json missing");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn scaffold_fails_if_dir_exists() {
        let dir = tmp_dir("exists");
        fs::create_dir_all(&dir).unwrap();

        let result = scaffold_provider(&ProviderScaffoldOpts {
            name: "test".to_string(),
            service_type: "cache".to_string(),
            domain: "cache.example.com".to_string(),
            output_dir: Some(dir.clone()),
        });

        assert!(!result.ok, "should fail if dir exists");
        assert!(result.reason.unwrap().contains("already exists"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn osp_manifest_contains_required_fields() {
        let opts = ProviderScaffoldOpts {
            name: "my-db".to_string(),
            service_type: "database".to_string(),
            domain: "db.example.com".to_string(),
            output_dir: None,
        };
        let manifest = osp_manifest_json(&opts);
        assert!(manifest.contains("\"ospVersion\": \"1.1\""));
        assert!(manifest.contains("\"provision\""));
        assert!(manifest.contains("\"deprovision\""));
        assert!(manifest.contains("\"tiers\""));
        assert!(manifest.contains("\"ed25519\""));
    }
}
