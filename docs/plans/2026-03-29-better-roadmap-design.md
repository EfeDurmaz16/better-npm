# better — Complete Roadmap Design

**Date:** 2026-03-29
**Author:** Efe Baran Durmaz
**Status:** Approved

---

## Vision

**"Everything npm should have been."** — the fastest, smartest, most secure universal package manager. One binary, every ecosystem, with native Sardis/OSP integration for the agent economy.

## Positioning

- All-in-one toolkit + speed king + enterprise-grade + Sardis-native
- Universal: npm + pip + cargo + go + swift + ruby + php + .NET
- First payment-aware package manager (Sardis wallet)
- First AI-agent-native package manager (LLM context, MCP, structured output)
- First package manager with integrated service provisioning (OSP)

## Architecture Decisions

- **Rust-only engine.** JS layer is a thin CLI wrapper that calls Rust via NAPI or subprocess. No JS fallback engine.
- **Engine trait system.** Rust core defines `PackageEngine` trait. Each ecosystem implements it. Shared CAS, lockfile, and audit across all engines.
- **Binary + JSON sidecar lockfile.** `better.lock` (binary, <1ms Rust parse) + `better.lock.json` (human-readable, git-diffable).
- **Universal CAS.** `~/.better/cas/` deduplicates across ALL ecosystems.
- **Distribution:** `curl -fsSL https://better.sh/install | sh`, `npm i -g better`, `brew install better`.

## Engine Trait System

```rust
trait PackageEngine {
    fn detect(project_root: &Path) -> bool;
    fn resolve(&self, manifest: &Manifest) -> LockGraph;
    fn fetch(&self, packages: &[Package]) -> Vec<Artifact>;
    fn materialize(&self, artifacts: &[Artifact], target: &Path);
    fn audit(&self, graph: &LockGraph) -> Vec<Vulnerability>;
}

struct NpmEngine;      // v0.3
struct PythonEngine;   // v0.6
struct CargoEngine;    // v0.9
struct GoEngine;       // v0.9
struct SwiftEngine;    // v1.1
struct RubyEngine;     // v1.1
struct PhpEngine;      // v1.2
struct DotNetEngine;   // v1.2
```

---

## v0.2 — Foundation

**Goal:** Make better installable, publishable, and trustworthy. Fix all known bugs. Clean house.

### Features

| Feature | What | Why |
|---------|------|-----|
| Remove dead TS layer | Delete `src/cli.ts`, `src/cli/commands/*.ts`, `tests/`, `tsup.config.ts`, `dist/` | Maintenance confusion, false coverage, dead code |
| CI/CD pipeline | GitHub Actions: test on push, cross-platform Rust builds on tag, auto-release | No releases possible without this |
| npm publish setup | Remove `private: true`, add `files` field, `.npmignore`, `prepublishOnly` script | `npm i -g better` must work |
| Homebrew tap | `homebrew-better` repo with formula pointing to GitHub Release binaries | `brew install better` |
| Fix `outdated` to parallel | `Promise.all` / Rayon concurrent registry hits instead of sequential for-loop | Currently unusable for large projects |
| Fix `why` for pnpm/yarn | Implement full lockfile graph parsing for pnpm-lock.yaml and yarn.lock | Currently returns empty results |
| Fix Rust audit parser | Replace hand-rolled JSON with `serde_json` proper parsing | Fragile, index-drift bugs |
| Split `lib.rs` | Break 5700-line monolith into `resolve.rs`, `fetch.rs`, `materialize.rs`, `cas.rs`, `audit.rs`, `workspace.rs`, `policy.rs`, `sbom.rs` | Unmaintainable as single file |
| Version command | `better --version` reads from `Cargo.toml` or embedded at build time | Basic CLI expectation |
| Completions | `better completions bash/zsh/fish` — shell completions generator | Table stakes DX |

---

## v0.3 — Speed + Core

**Goal:** Become the undisputed fastest package manager. Kill JS engine. Rust-only hot path. Introduce `better.lock`.

### Features

| Feature | What | Why |
|---------|------|-----|
| Kill JS install engine | Remove `src/engine/better/`. Rust binary is the only engine. JS = thin wrapper. | Single source of truth. No dual maintenance. |
| Expand NAPI to all commands | Expose audit, license, outdated, workspace, doctor, policy, SBOM via NAPI | Eliminates subprocess fork overhead (~50ms per command) |
| `better.lock` (binary + JSON) | Custom lockfile. Binary format for <1ms Rust parsing. JSON sidecar for git diffs. Contains: package versions, CAS addresses, integrity hashes, dep graph. | Faster than package-lock.json. Git-friendly. Your format. |
| `better.lock` git merge driver | `git config merge.betterlock.driver "better lock merge %O %A %B"`. Auto-resolves lockfile conflicts. | Pain point #7 — lockfile merge conflicts |
| Parallel outdated (Rust) | Rayon parallel registry queries. Batch semver resolution. | 200 deps in <500ms |
| Parallel audit (Rust) | Batch OSV.dev API calls via batch endpoint. | 1-3 requests total instead of N |
| HTTP/2 multiplexed fetching | `reqwest` with HTTP/2 connection pooling. Multiplex requests over single TCP. | Eliminates per-package TCP handshake |
| Streaming extraction | Download stream -> decompress stream -> extract to CAS. No temp files. | Memory efficient, eliminates write-read-write |
| Lazy node_modules | `--lazy` flag: only materialize packages actually imported at runtime. Warn on unused. | Opt-in, saves disk + time |
| Global CAS v2 | File-level CAS. Identical files across different packages share one inode. | 30-40% further disk savings |
| Benchmark CI | Auto-run benchmarks on every PR. Post results as comment. Track regression. | Prove speed claims. Catch regressions. |
| Install progress TUI | Real-time: resolving -> fetching (speed) -> extracting -> linking. Package count + bytes. | UX expectation for fast tools |
| Engine trait system | Define `PackageEngine` trait in Rust. Refactor npm code into `NpmEngine` impl. Prepare for future engines. | Architecture foundation for universal PM |

---

## v0.4 — Intelligence

**Goal:** Make better the smartest package manager. Context-aware security. Strict deps. Actionable insights.

### Features

| Feature | What | Why |
|---------|------|-----|
| Smart audit | Context-aware: prod vs devDep vs build-only. Severity x reachability scoring. `better audit --prod-only`. | npm audit is broken (99%+ false positives). Killer feature. |
| Audit allow-listing | `better audit --ignore CVE-2024-XXXX` with `.betterauditrc.json`. Per-CVE waivers with expiry + reason. | Enterprise need. npm can't suppress false positives. |
| Strict dependency isolation | No phantom deps. Each package only `require()` declared deps. Symlink structure (pnpm-style). `better install --strict`. | Pain point #6. pnpm proved this works. |
| Dependency approval workflow | `better policy approve lodash@4.17.21`. Allow-list of approved packages. Install fails if unapproved package found. | Enterprise governance. |
| Unused dependency detection | `better doctor --unused`. Static analysis: scan source for imports, cross-reference with package.json. | Built-in depcheck. |
| Duplicate dependency advisor | `better dedupe --fix`. Suggest and apply resolution overrides to collapse dupes. | Current dedupe only detects. Actionable = useful. |
| License policy enforcement | `better license --policy .betterlicenserc.json`. Allow/deny lists. Exit 1 in CI. SPDX expression parsing. | Enterprise compliance. |
| Vulnerability database caching | Cache OSV.dev locally. `better audit --refresh`. Offline audit from cache. | Faster repeat audits. Offline. |

---

## v0.5 — Enterprise

**Goal:** The package manager security teams actually want. Real enforcement, not theater.

### Features

| Feature | What | Why |
|---------|------|-----|
| Real script sandboxing | Sandbox postinstall: no network, no fs outside package dir, no env vars. Deno-style permissions. `sandbox-exec` (macOS) / `seccomp-bpf` (Linux). Allowlist in `.better-scripts.json`. | Pain point #5. 48% of npm malware uses install scripts. |
| SBOM v2 | CycloneDX 1.6 + SPDX 2.3 + VEX. Build environment, source hash, dep provenance. `better sbom --vex`. | EU CRA, US EO 14028 compliance. VEX is differentiator. |
| Policy engine v2 | Rules: max install size, required maintainers, min publish age (anti-typosquat), required 2FA, source-available requirement. | Enterprise needs deep control. |
| Provenance verification | Verify Sigstore attestations. `better install --verify-provenance`. Warn/fail without provenance. | npm added provenance but no PM enforces it. |
| Private registry v2 | Multi-registry with priority. Scoped + unscoped routing. Token rotation. `better registry add/remove/list`. | Enterprise registry management. |
| Install receipt | `.better-receipt.json`: what installed, from where, integrity verified, sandbox results, policy score. Immutable audit trail. | Enterprise audit requirement. No PM does this. |
| Dependency firewall | `better firewall enable` — block typosquats (Levenshtein), zero-day publishers, inline binary blobs. Real-time during install. | Proactive defense vs reactive audit. |

---

## v0.6 — Universal (Python Engine)

**Goal:** Prove the universal PM thesis. Python second ecosystem — pip is hated, uv proved demand.

### Features

| Feature | What | Why |
|---------|------|-----|
| Project auto-detection | `better install` scans for `package.json` -> npm, `pyproject.toml`/`requirements.txt` -> python, both -> polyglot. Zero config. | One command everywhere. |
| Python resolver | PEP 440 resolution in Rust. Parse pyproject.toml (PEP 621), requirements.txt. Resolve from PyPI JSON API. Handle extras, markers. | uv proved Rust resolves Python 10-100x faster. |
| Wheel/sdist fetcher | Download wheels (platform-specific -> universal -> sdist fallback). Verify hashes. Cache in universal CAS `~/.better/cas/pypi/`. | Same CAS as npm. Cross-ecosystem dedup. |
| Virtual environment management | Auto-create `.venv/`. `better run python script.py` activates transparently. `better shell` drops into venv. | uv does this. Table stakes. |
| Universal lockfile v2 | `better.lock` gains `[python]` section alongside `[npm]`. One lockfile for polyglot projects. | One source of truth. |
| Cross-ecosystem audit | `better audit` queries OSV.dev for npm AND PyPI in one pass. Unified report. | No tool audits across ecosystems. First mover. |
| `better migrate --from pip` | Read requirements.txt / Pipfile / poetry.lock / uv.lock -> generate `better.lock` python section. | Migration for Python teams. |
| Python script runner | `better run pytest`, `better run uvicorn`. Auto-resolves from `.venv/bin/`. Dotenv works for Python too. | Consistent DX across ecosystems. |

---

## v0.7 — Agentic

**Goal:** First package manager built for AI agents. Structured output, LLM context, MCP server.

### Features

| Feature | What | Why |
|---------|------|-----|
| Structured JSON output | `better --json install/audit/etc`. Every command outputs machine-parseable JSON. Errors on stderr as JSON. | Agents can't parse human tables. |
| `better context <package>` | Generate LLM-friendly docs from TypeDoc/JSDoc/type defs/README/CHANGELOG. Condensed markdown optimized for context windows. | World first. AI agents get package + knowledge. |
| `better context --all` | Generate `.better/context/` for all deps. Auto-runs after `better install --with-context`. | One command = full project context for any agent. |
| Context protocol | Packages publish `.better-context.md` or `better.context.json`. Schema: exports, signatures, usage examples, gotchas, migration notes. | Community standard for AI-friendly packages. |
| MCP server | `better mcp` starts MCP server. Tools: install, add, remove, audit, why, context, outdated, search, provision (OSP). stdio/SSE. | Agents manage deps programmatically. |
| Agent mode | `better agent install` — silent, JSON, auto-approve, no TUI, no color. Semantic exit codes (0=ok, 1=dep-error, 2=security, 3=policy). | Predictable non-interactive behavior. |
| Package search with ranking | `better search "http server"` — npm + PyPI. Downloads, maintenance, security score, context availability. `--json`. | Agent package discovery. |
| Dependency suggestion | `better suggest` — analyze imports, suggest missing deps, flag unused. AST via SWC (JS) / tree-sitter (Python). | Proactive, not reactive. |
| Context cache | `~/.better/context/` versioned by package@version. Shareable. `better context gc`. | Fast for agents. No regeneration. |

---

## v0.8 — Sardis + OSP

**Goal:** First payment-aware package manager. Deep Sardis/OSP integration. Service provisioning + package monetization.

### OSP Service Provisioning

| Feature | What | Why |
|---------|------|-----|
| `better login --sardis` | Authenticate with Sardis. Store wallet credentials in `~/.better/credentials.json` (encrypted). | Auth foundation. |
| `better provision` | `better provision supabase/postgres --tier free`. Fetch `/.well-known/osp.json`, verify Ed25519 signature, send ProvisionRequest, receive CredentialBundle, store in vault. Handle sync (200) and async (202+polling). | Core OSP integration. Agents provision infra from CLI. |
| `better provision` with payment | `better provision vercel/pro --tier pro --pay sardis`. Create SpendingMandate, attach payment_proof. Escrow hold on success. Cost estimate first. | Paid services in one command. |
| `better services` | `better services list` — all provisioned services with status, credentials (masked), tier, cost. `better services status supabase/postgres`. | Manage infrastructure from better. |
| `better env generate` | Read `osp://` URIs from `.env.osp` template, resolve from vault, write `.env`. `DATABASE_URL=osp://supabase.com/postgres/connection_string` -> actual value. | Killer DX — osp:// URIs auto-resolved. |
| `better credentials rotate` | Call OSP rotate endpoint. Update vault. Re-generate `.env`. Zero-downtime. | Automated security hygiene. |
| `better deprovision` | Call OSP deprovision. Clean vault. Warn if `.env` references this service. | Clean teardown. |
| OSP manifest verification | Always verify `provider_signature` (Ed25519 canonical JSON). Reject unsigned. Nonce replay protection. Idempotency keys. | Spec requirement. Security. |
| Encrypted credential storage | Vault at `~/.better/vault/` encrypted X25519+AES-256-GCM. Agent keypair on first use. Provider encrypts with agent pubkey. | No plaintext credentials ever. |
| `better discover` | `better discover database` — search OSP providers by category. Registry + curated list fallback. | Agents find services. |
| Agent provisioning | `better agent provision supabase/postgres --json`. Structured output. Auto-approve. Agent's Sardis wallet pays. | Agents provision and pay for infra. |

### Package Monetization

| Feature | What | Why |
|---------|------|-----|
| `better pay` | `better pay lodash` — micropayment via Sardis wallet. `better pay --all --budget 50USD` — distribute across deps. `better pay --recurring monthly`. | Sustainable OSS funding. Separate from OSP provisioning. |
| `better publish --monetize` | Publish with Sardis payment: `pricing: { model: "donation" \| "pay-what-you-want" \| "per-install" }` in package.json. | Package monetization. |
| Revenue dashboard | `better earnings` — revenue from published packages. `better earnings --breakdown` — per-package, per-day. | Maintainer income visibility. |
| `better sponsor` | One-time or recurring. `sponsors` field in `better.lock`. `better sponsors list`. | Social proof + funding. |
| Enterprise Sardis | `better pay --org mycompany` — company-level budget. Admin dashboard. Compliance report. SOC2 audit trail. | Enterprise OSS compliance. |

---

## v0.9 — Ecosystems

**Goal:** Cargo + Go engines. Universal CAS proven across 4 ecosystems. Polish.

### Features

| Feature | What | Why |
|---------|------|-----|
| Cargo engine | Parse `Cargo.toml`/`Cargo.lock`. Resolve from crates.io. Universal CAS. | Big 4 #3. Rust devs are early adopters. |
| Go engine | Parse `go.mod`/`go.sum`. Resolve from Go proxy. Universal CAS. | Big 4 #4. Simple — proves universal model. |
| Cross-ecosystem monorepo | `better workspace` handles Node + Python + Rust + Go. Topological ordering across ecosystems. Shared CAS. | Real polyglot monorepos. |
| Cross-ecosystem OSP | `better provision` works in any ecosystem project. `.env` generation for all. | OSP is ecosystem-agnostic. |
| `better migrate` (all) | Auto-detect: package-lock.json, yarn.lock, pnpm-lock.yaml, Pipfile.lock, poetry.lock, uv.lock, Cargo.lock, go.sum -> unified better.lock. | One-command migration from anything. |
| Registry failover | npm down -> Cloudflare mirror. PyPI down -> Google mirror. Auto-detect outages. Configurable. | SPOF elimination. |
| Offline mode | `better install --offline` from local CAS. `better cache prefetch`. | Air-gapped, airplane, CI without network. |
| Plugin system | `better plugin add @better/docker`. Rust dylibs or WASM. API: custom engines, audit sources, policies, OSP providers. | Community extends better. |
| `better doctor` v2 | Cross-ecosystem health: duplicate native libs, version conflicts across ecosystems, CAS orphans, OSP credential expiry warnings. | Universal intelligence. |
| Universal dedup stats | `better cache stats` — CAS across all ecosystems. Shared lib detection. Total savings report. | Prove the value prop. |

---

## v1.0 — Launch

**Goal:** Production-ready. Stable API. World announcement. "One tool for everything."

### Features

| Feature | What | Why |
|---------|------|-----|
| Stable CLI API | Semver guarantee. `--json` schema versioned. Deprecation warnings 2 minors before removal. | Enterprise trust. |
| `better.sh` docs site | Getting started, migration guides (npm/pip/cargo/yarn/pnpm/uv/poetry), command reference, plugin authoring, OSP guide, Sardis guide, LLM context guide. | Professional docs = professional tool. |
| Homebrew formula | `brew install better` via tap. Auto-updated on release. | macOS expectation. |
| Docker images | `ghcr.io/better/better:latest` (all engines), `:slim` (npm-only). Alpine-based. | Container-first CI. |
| VS Code extension | Inline version hints, audit gutter warnings, one-click update, LLM context hover panel, OSP service sidebar, `better.lock` syntax highlighting. | IDE integration = adoption. |
| GitHub Action | `better/setup-better@v1`, `better/audit-action@v1`, `better/provision-action@v1`. | CI where it lives. |
| `better upgrade` | Self-update binary. Latest or pinned version. Checksum verification. Rollback on failure. | Self-updating tools retain users. |
| Benchmarks site | `better.sh/benchmarks` — live CI-generated vs npm/pnpm/bun/yarn/pip/uv/cargo. | Speed claims need proof. |
| Telemetry (opt-in) | Anonymous: commands, times, CAS hits, ecosystems, OSP provisions. `better telemetry off`. Dashboard. | Data-driven roadmap. |
| Launch blog post | Architecture deep-dive: universal CAS, binary lockfile, engine traits, OSP, Sardis, LLM context. Target: HN front page. | One shot first impression. |

---

## v1.1 — Mobile + Ruby

**Goal:** iOS and Ruby ecosystems. Broader context generation.

### Features

| Feature | What | Why |
|---------|------|-----|
| Swift/SPM engine | Parse `Package.swift`. Resolve from Swift Package Registry. Universal CAS. | iOS is massive. SPM is slow. |
| CocoaPods compat | `better migrate --from cocoapods` reads Podfile.lock -> better.lock swift section. Resolve from CDN. | Migration for millions on CocoaPods. |
| Ruby/Bundler engine | Parse `Gemfile`/`Gemfile.lock`. Resolve from rubygems.org. Universal CAS. | Ruby community hungry for speed. |
| Context for all ecosystems | LLM context from DocC (Swift), YARD (Ruby), Sphinx (Python), rustdoc (Rust). | Universal AI-friendliness. |
| OSP provider SDK | `better provider init` — scaffold OSP provider. Auto-generates manifest, endpoints, conformance tests. | Grow OSP ecosystem from inside better. |
| Cross-ecosystem dep graph | `better graph` — interactive web visualization. All ecosystems color-coded. Clickable for context + audit + license. | Beautiful, demo-worthy. |

---

## v1.2 — PHP + .NET + CI Deep

**Goal:** Enterprise ecosystems. Deep CI integration.

### Features

| Feature | What | Why |
|---------|------|-----|
| PHP/Composer engine | Parse `composer.json`/`composer.lock`. Resolve from packagist.org. Universal CAS. | PHP = 77% of web. Composer is slow. |
| .NET/NuGet engine | Parse `*.csproj`/`packages.config`. Resolve from nuget.org. Universal CAS. | Enterprise .NET teams. |
| `better ci` | `better ci` = install --frozen + verify-provenance + audit + policy check + sbom + receipt. One command. | CI = one command, not 50-line YAML. |
| PR bot | GitHub App: `@better-bot audit`. Auto-comments: new deps (license, maintainers, security), removed, upgraded, policy violations, context availability. | Automated dep review in PRs. |
| `better diff` | `better diff HEAD~1` — dep changes between commits. Added, removed, up/downgraded. Security impact. | Understand dep changes without reading lockfile. |
| Merge queue integration | `better lock merge-driver` in `.gitattributes`. Auto-resolve in merge queue. | Merge queues + lockfile conflicts = broken CI. Solved. |

---

## v1.3 — Decentralized + Federation

**Goal:** No single points of failure. Content-addressed everything.

### Features

| Feature | What | Why |
|---------|------|-----|
| Decentralized registry | DRPM-style via OSP/Sardis infra. Packages are content-addressed (IPFS CIDs or similar). Registry = discovery, not hosting. Multiple mirrors. | npm SPOF owned by Microsoft. |
| Registry federation | `better registry add my-company.dev`. Resolution: private -> OSP -> public. Cross-registry CAS dedup. | Enterprise private + public + OSP in one chain. |
| Package signing | `better publish --sign` (Ed25519). `better install --verify-signatures`. Web of trust: org-level keys. | Supply chain integrity beyond attestation. |
| Reproducible builds | `better build --reproducible`. Compare artifact hash against published. `better verify <package>`. | Trust but verify. NixOS philosophy for npm/PyPI. |
| OSP registry integration | `better discover` queries OSP registry AND decentralized better registry. Services + packages unified. | Unified discovery. |
| Content-addressed publishing | `better publish` generates CAS hash. Same content = same hash regardless of registry. | Packages as immutable facts. |

---

## v1.4 — Deploy + Infra

**Goal:** From package manager to deployment platform. Infrastructure as dependencies.

### Features

| Feature | What | Why |
|---------|------|-----|
| `better deploy` | `better deploy --vercel/--cloudflare/--railway/--fly`. Auto-detect framework, build, deploy. Use OSP credentials. | PM knows deps -> optimizes deploy. |
| Deploy with auto-provision | `better deploy --provision`. Read `.env.osp`, provision missing services via OSP, inject creds. Zero-to-production. | "Clone, `better deploy --provision`, done." |
| Infrastructure as deps | In `package.json`/`better.toml`: `"services": { "db": "osp://supabase/postgres@free" }`. `better install` provisions both packages AND services. | Services = first-class deps. |
| Environment management | `better env dev/staging/production`. Switch OSP environments. Each has own services + creds. `better env clone dev staging`. | Multi-env from one tool. |
| `better preview` | Deploy preview with ephemeral OSP services. Auto-deprovision after TTL. PR preview URLs with real infra. | Preview environments, not mocks. |
| Cost dashboard | `better costs` — total across all OSP services, envs, projects. `better costs optimize` — suggest cheaper tiers/alternatives. | FinOps from CLI. |

---

## v1.5 — Intelligence v2

**Goal:** ML-powered dependency intelligence. Predictive, not reactive.

### Features

| Feature | What | Why |
|---------|------|-----|
| Package reputation score | ML 0-100 trust score. Signals: maintainer activity, download anomalies, vuln history, bus factor, typosquat distance, publish frequency. Updated daily. | Proactive security. Catch malicious before CVE. |
| `better upgrade --smart` | AI-assisted: read changelogs, breaking changes, usage patterns. Suggest safe path. Generate migration code. Test after each. | Major upgrades made safe. |
| Dependency impact analysis | `better impact lodash` — depth of usage, which files, what breaks if removed, alternatives with context comparison. | Informed dep decisions. |
| Supply chain graph | `better supply-chain` — full trust chain visualization. Who published, from where, CI, signing. Flag anomalies. | Supply chain transparency. |
| Auto-fix vulns | `better audit --fix` — upgrade to patched, run tests, commit if pass, rollback if not. | Smarter than `npm audit fix --force`. |
| Predictive maintenance | `better predict` — predict unmaintained deps from activity trends. Suggest alternatives proactively. | Plan ahead, don't wait for abandonment. |

---

## v2.0 — AI-Native

**Goal:** Natural language dependency management. AI-first, human-friendly.

### Features

| Feature | What | Why |
|---------|------|-----|
| `better ai` | `better ai "add auth to this project"` — analyze codebase, suggest packages, compare via LLM context, install, generate boilerplate, provision OSP auth service. Powered by Claude/Sardis. | Natural language -> working code with deps. |
| `better ai review` | AI reviews dep choices. "moment.js -> date-fns (10x smaller). 3 HTTP clients -> consolidate." | AI dependency hygiene. |
| `better ai migrate` | `better ai migrate "Express 4 to 5"` — read migration guide from context, apply changes, test, handle breaking changes. | Automated major migrations. |
| `better ai provision` | `better ai "I need a database for user data"` — analyze model, suggest Supabase vs PlanetScale vs Turso, provision via OSP, generate schema, inject creds. | Natural language to running infra. |
| Agent orchestration | `better agent pipeline` — chain: provision -> install -> migrate -> deploy. Autonomous. HITL gates from OSP spec. | Autonomous deployment pipelines. |
| Self-healing deps | `better watch --heal` — real-time CVE monitoring. Auto-upgrade, test, PR. If no patch: suggest alternative, generate migration. | Autonomous security maintenance. |
| Cross-project intelligence | `better insights` — analyze deps across all projects. Inconsistent versions, redundant packages, shared configs to extract. | Organizational-level intelligence. |

---

## Feature Count Summary

| Version | Features | Cumulative |
|---------|----------|------------|
| v0.2 Foundation | 10 | 10 |
| v0.3 Speed + Core | 13 | 23 |
| v0.4 Intelligence | 8 | 31 |
| v0.5 Enterprise | 7 | 38 |
| v0.6 Universal (Python) | 8 | 46 |
| v0.7 Agentic | 9 | 55 |
| v0.8 Sardis + OSP | 16 | 71 |
| v0.9 Ecosystems | 10 | 81 |
| v1.0 Launch | 10 | 91 |
| v1.1 Mobile + Ruby | 6 | 97 |
| v1.2 PHP + .NET + CI | 6 | 103 |
| v1.3 Decentralized | 6 | 109 |
| v1.4 Deploy + Infra | 6 | 115 |
| v1.5 Intelligence v2 | 6 | 121 |
| v2.0 AI-Native | 7 | 128 |

**Total: 128 features across 15 versions.**

---

## Ecosystem Support Timeline

| Ecosystem | Version | Engine |
|-----------|---------|--------|
| npm (Node.js) | v0.2 (existing) | NpmEngine |
| Python (pip/uv) | v0.6 | PythonEngine |
| Rust (cargo) | v0.9 | CargoEngine |
| Go (go modules) | v0.9 | GoEngine |
| Swift (SPM) | v1.1 | SwiftEngine |
| Ruby (bundler) | v1.1 | RubyEngine |
| PHP (composer) | v1.2 | PhpEngine |
| .NET (NuGet) | v1.2 | DotNetEngine |
| Community (WASM plugins) | v0.9+ | PluginEngine |

---

## Key Integration Points with OSP

1. **Discovery:** `better discover` queries `/.well-known/osp.json` or `registry.osp.dev`
2. **Provisioning:** `better provision` sends `ProvisionRequest` per OSP v1.1 spec
3. **Credentials:** Stored in `~/.better/vault/` encrypted with X25519+AES-256-GCM
4. **Resolution:** `osp://` URIs in `.env.osp` resolved to actual values
5. **Payment:** Sardis wallet `SpendingMandate` attached as `payment_proof`
6. **Escrow:** `EscrowHold` created on successful provision of paid services
7. **MCP:** `better mcp` exposes OSP tools alongside package management tools
8. **LLM Skills:** Fetch provider skills from `/.well-known/osp-skills.md`
9. **A2A:** Agent-to-agent delegation for provisioning
10. **Infra as deps:** `"services"` field in manifests, resolved during `better install`
