# Shipped Features Snapshot

Reality check date: 2026-03-29

This snapshot is based on the current local checkout plus `git fetch origin` on 2026-03-29.
At that moment, local `main` was `ahead 51, behind 11` relative to `origin/main`.

This file is the shared baseline for the March roadmap drafts. The plan files are kept, but they should be read against this snapshot instead of assuming every task below them is untouched work.

## Declared Project Status

The maintainer-provided status for this roadmap set is:

- v0.2 shipped
- v0.3 shipped
- v0.4 shipped
- v0.5 shipped
- v0.6 shipped
- v0.7 shipped
- v0.8 Sardis + OSP in progress

The sections below describe what is visible from the current checkout and recent local history. If active branch/worktree/agent work exists outside this checkout, treat that as project reality even when the source is not yet visible here.

## Repo Normalization Rules

- CLI command files live under `src/commands/*.js`, not `src/commands/*.ts`.
- Tests live under `test/*.test.js` and run via `node --test`, not `tests/*.test.ts` / Vitest.
- Rust engine code lives under `crates/better-core/src/engine/`, not `crates/better-core/src/engine.rs` or `crates/better-core/src/engines/`.
- Current machine-readable command contracts use `kind` plus integer `schemaVersion`. See `docs/json-schemas.md`.

## Shipped In Repo Now

### v0.2 Foundation

- Dead TS/Vitest cleanup landed. The old `tests/`, `dist/`, `src/cli.ts`, and related dead paths are already gone from this checkout.
- CI exists in `.github/workflows/ci.yml`.
- npm publish plumbing exists in `package.json` and `scripts/postinstall.js`.
- Homebrew formula exists in `scripts/homebrew/better.rb`.
- Version output exists in `src/cli.js` and `src/version.js`.
- Shell completions exist in the Rust CLI surface in `crates/better-core/src/main.rs`.
- `why` support for pnpm/yarn and Rust audit parser fixes are reflected in recent commit history.

### v0.3 Speed + Core

- JS install engine removal landed. Rust-only install path is reflected in recent commit history and current install flow.
- Rust module extraction from the old monolith landed; the current tree is already split into many files under `crates/better-core/src/`.
- Expanded NAPI bindings landed in `crates/better-napi/src/lib.rs`.
- `better.lock` support landed in `crates/better-core/src/lock.rs`, `crates/better-core/src/lock_merge.rs`, and CLI wiring in `crates/better-core/src/main.rs`.
- Merge driver / install-driver support landed in `crates/better-core/src/main.rs`.
- Streaming extraction landed; current fetch/materialize structure reflects that split.
- Install progress support landed in `crates/better-core/src/progress.rs`.
- `PackageEngine` trait and engine registry foundations landed in `crates/better-core/src/engine/mod.rs`.

### v0.4 Intelligence

- Smart audit foundations landed in `crates/better-core/src/audit/` and `src/commands/audit.js`.
- Audit waivers / allow-listing landed in `src/commands/audit.js`.
- Strict / hoist install controls landed in `src/commands/install.js`.
- Unused dependency detection landed in `src/commands/doctor.js` and Rust-side support.
- License policy enforcement landed in `crates/better-core/src/license_policy.rs` and `src/commands/license.js`.

### v0.5 Enterprise

- Provenance verification landed in `crates/better-core/src/provenance.rs`.
- Install receipt landed in `crates/better-core/src/receipt.rs`.
- Dependency firewall landed in `crates/better-core/src/firewall.rs`.
- Registry v2 / policy v2 foundations landed in recent commit history and current CLI wiring.
- Sandbox / approval / audit-config groundwork exists in `crates/better-core/src/sandbox.rs`, `crates/better-core/src/approval.rs`, and `crates/better-core/src/audit_config.rs`.

### v0.6 Universal Python

- Python engine foundation landed in `crates/better-core/src/engine/python/`.
- PyPI client, wheel/sdist fetching, version/specifier parsing, requirements parsing, and manifest handling all exist under `crates/better-core/src/engine/python/`.
- Auto-detection for polyglot projects landed in recent commit history and supporting code.
- Virtual environment support exists in `crates/better-core/src/venv.rs`.
- Multi-ecosystem lockfile foundations landed in recent commit history.
- Migration support for pip / Pipenv / Poetry landed in recent commit history.

### v0.7 Agentic

- Structured JSON output landed across commands and is documented in `docs/json-schemas.md`.
- Agent mode landed in `src/cli.js`.
- Context generation landed in `crates/better-core/src/context/` and current CLI surface.
- MCP server landed in `crates/better-core/src/mcp/`.
- Search across npm and PyPI landed in `crates/better-core/src/search/`.
- Dependency suggestion landed in `src/commands/suggest.js` and related helpers.

## Partially Landed / Shape Changed

- Several roadmap items landed in a different shape than the March drafts describe. The main examples are:
- NAPI is present, but the JS wrapper still shells out to `better-core` for some commands instead of being NAPI-only everywhere.
- Some enterprise features exist as groundwork modules but are not obviously complete to the exact roadmap spec.
- Some “future” plan items are already present in code or commit history, but the plan files still describe them as untouched work.

## Not Yet Visible In This Checkout / Still Planned

- v0.8 Sardis + OSP source modules are not present in the current checkout. There is no `sardis/`, `osp/`, `monetize/`, or `crypto/` subtree under `crates/better-core/src/` here, even though project status says v0.8 is in progress.
- v0.9 Cargo + Go engines are not present in the current source tree.
- v1.0 docs site, VS Code extension, launch collateral, and telemetry do not appear to be landed in this checkout.
- v1.1 Swift/SPM, CocoaPods, Ruby/Bundler, and OSP provider SDK do not appear to be landed.
- v1.2 PHP / .NET engines and deep CI features do not appear to be landed.
- v1.3 decentralized registry / federation work does not appear to be landed as described.
- v1.4 deploy + infra platform work does not appear to be landed.
- v1.5 ML-powered intelligence features do not appear to be landed.
- v2.0 AI-native orchestration and natural-language package management do not appear to be landed.

## Reading Guidance

- Treat the March plan files as drafts that need rebasing onto the current repo state.
- Do not assume a task is still open just because it appears below in a plan.
- For v0.8-dependent plans, treat Sardis/OSP-linked tasks as in-progress at project level but not yet landed in this checkout unless corresponding source modules are visible.
