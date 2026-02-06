# Better vNext: Bun Engine + Rust Core Materializer (Plan)

> Goal: Make Node.js dependency installs **fast**, **space-efficient**, **verifiable**, and **explainable**—while keeping Node.js as the runtime. Better can be adopted incrementally, like Bun, but **does not replace Node**.

## Executive Summary

Better evolves from a “wrapper toolkit” into a **tiered installation system**:

1. **Safe wrapper mode (default):** run the project’s package manager (npm/pnpm/yarn) unchanged; Better wires shared caches + measures + explains.
2. **Turbo engine mode (opt-in):** run `bun install` for speed, with explicit **parity checks** and clear warnings that semantics may differ.
3. **Better materializer mode (experimental → stable):** **replay an existing lockfile** (no resolution) and materialize dependencies using a global content-addressed store (CAS) + hardlinks/reflinks to drastically reduce I/O and disk usage.

This keeps trust by default while enabling an “all-in-one toolkit feel” through composable commands: `install`, `analyze`, `doctor`, `cache`, plus future `pack/restore`, `why`, and `policy`.

---

## Why not “just use Bun”?

If “npm is slow” is the only goal, then “just use Bun” is a valid answer for many teams.
Better exists because the actual pain you described is broader and longer-lived:

1) **Trust + explainability (production tooling)**
- Bun is a fast npm client; it does not primarily optimize for *explainability*.
- Better’s default contract is: every metric is reproducible, every decision is explainable, and every fallback is logged.

2) **Semantics and ecosystem variance**
- `bun install` can differ from npm/pnpm/yarn in edge cases (peers, workspaces, scripts, optional deps, registries).
- Better treats Bun as an **opt-in engine** with **parity checks** and lockfile policies. That’s how we ship speed without eroding trust.

3) **Node.js runtime stays the runtime**
- We explicitly do not want “Bun the runtime” for backend.
- Better stays compatible with Node.js projects and CI norms.

4) **node_modules pain isn’t fully solved by a faster client**
- The real long-term win is reducing I/O and disk via a **lockfile-replay materializer** and **CAS**, plus portability (`pack/restore`) and organization-level policy.
- Those are independent of which engine performed the install.

In short: Bun can be the **fast engine**; Better is the **system** that makes dependency management measurable, debuggable, portable, and policy-able across engines.

---

## Current Repo Status (2026-02-04)

This repository already has an MVP CLI in Node.js:
- `better install` (pm wrapper + metrics + optional baseline run)
- `better analyze` (deterministic attribution + lightweight UI)
- `better cache` (stats/gc/explain for Better roots + artifacts)
- `better doctor` (rule-based findings + itemized score)

vNext work focuses on:
1) adding `--engine bun` + parity checks (speed track)
2) moving hot paths to Rust core (scale track)
3) adding lockfile-replay materializer + CAS (node_modules pain track)

---

## Product Principles (vNext)

1. **Trust first:** default behavior must not silently change dependency resolution.
2. **Deterministic by default:** offline, reproducible metrics and analysis from local state.
3. **Explainable metrics:** every number has a derivation path (inputs, method, limitations).
4. **Cross-project efficiency:** global reuse is a feature, not hidden.
5. **Escape hatches everywhere:** fallback to copy mode, fallback to underlying PM, disable optimizations.

---

## Modes and Contracts

### Install engines

| Engine | Command | Semantics promise | Primary use |
|---|---|---|---|
| `pm` (default) | `better install` | Same as npm/pnpm/yarn | Trustworthy baseline, measurement |
| `bun` (opt-in) | `better install --engine bun` | Best-effort parity | Speed experimentation |
| `better` (experimental) | `better install --engine better` | Lockfile replay only | Max speed + max disk savings |

### Output contract (stable)

All commands support:
- human output (default)
- `--json` for a stable schema with `kind` + `schemaVersion`

**Run report** (`better.install.report.v1`) is the backbone:
- engine, pm detected, mode, timestamps
- node_modules logical/physical sizes (hardlink-aware)
- cache roots used + deltas (best-effort)
- parity results (when applicable)
- warnings + fallbacks used

---

## vNext CLI UX (Decision-Complete)

### `better install`

#### Flags
- `--engine pm|bun|better` (default `pm`)
- `--pm npm|pnpm|yarn|auto` (for `--engine pm`)
- `--baseline run|estimate|off` (default `estimate`)
- `--parity-check off|warn|strict` (default: `warn` when `--engine bun`, `off` when `--engine pm`)
- `--lockfile-policy keep|allow-engine` (default `keep`)
- `--cache-root PATH` (override Better root)
- `--no-cache` (do not wire Better-managed caches)
- `--report PATH` (write run report)
- passthrough args after `--`

#### Parity check definition (Bun engine)
`--parity-check` compares:
1) **Lockfile drift**
   - default: `package-lock.json`/`pnpm-lock.yaml`/`yarn.lock` must remain unchanged (`keep` policy).
   - if `allow-engine`: record engine lockfile outputs (`bun.lockb`) and mark run as “migrating”.
2) **Installed package set**
   - compute stable set hash of `name@version` discovered via `node_modules/**/package.json`
   - optionally compare to a lockfile-derived expected set when parsing is available
3) **Runtime sanity**
   - optional `--parity-check strict` runs a small suite: `node -e "require('<direct dep>')"` for each direct dep (configurable cap)

Parity output must be itemized and explainable; never “green” without showing what was checked.

---

## Architecture (Hybrid)

### Why Rust core
The hot paths (millions of `stat/readdir`, inode/file-id dedupe, package boundary detection, large graphs) are I/O-heavy and CPU-bound. JS runtimes suffer from syscall overhead + GC on large maps; Rust can:
- parallelize safely (`rayon`)
- use OS-specific file identity APIs robustly (Windows file-id)
- keep memory predictable

### Integration shape (recommended)
Start with **a `better-core` binary** (Rust) invoked by the CLI:
- CLI calls `better-core analyze --json` / `better-core scan ...`
- exchange is JSON (or msgpack later)

Benefits: simplest distribution + crash isolation; can move to `napi-rs` later if needed.

---

## Core Capabilities (What we add beyond today)

### 1) Content-Addressed Store (CAS)
- Store tarballs and/or unpacked file contents by hash
- Atomic writes (temp + rename)
- Metadata DB (sqlite) for:
  - refcounts by project snapshot
  - last access
  - provenance (url, integrity, time)

### 2) Materializer (node_modules)
Materialize from lockfile replay:
- Prefer `reflink` where available (APFS, btrfs, etc.)
- Else hardlink
- Else copy

**Script/native addon model**
- Separate “build outputs” cache keyed by:
  - package content hash
  - platform + arch
  - Node ABI
  - relevant env fingerprints
- “scriptful packages” are isolated by default (no shared mutable artifacts)

### 3) Project mobility
- `better pack` → produce a small, portable artifact (lockfile + snapshot + pointers)
- `better restore` → hydrate using CAS (local or remote)
- `better cache export/import` → move CAS to CI/artifacts/S3

### 4) Security / assurance
- enforce integrity when lockfile provides it
- provenance log (what came from where)
- optional policy engine (`better policy`) with allowlist/blocklist and script rules

---

## Roadmap (Phased, Acceptance-Based)

### Phase 1 — Bun engine (fast wins)
Deliver:
- `better install --engine bun`
- parity checks (`warn|strict`)
- lockfile policy enforcement
- clear run report additions (engine, parity results)

Acceptance:
- bun engine works on 5 representative repos (single-package + workspace)
- strict parity check catches intentional drift in fixtures

### Phase 2 — Rust core acceleration for analyze/doctor
Deliver:
- `better-core` binary: scan + hardlink-aware sizing + package discovery
- CLI routes `better analyze` and `better doctor` through core on large repos (threshold-based)

Acceptance:
- analyze 2.2GB node_modules < 10s on a reference machine
- deterministic output hash for unchanged filesystem snapshot

#### Phase 2 — Detailed implementation tasks (decision complete)

**Tech stack decision**
- Keep the CLI in Node.js/TypeScript for ecosystem interop and rapid iteration.
- Move hot paths to a **Rust std-only binary** (`crates/better-core`) speaking JSON over stdout/stderr.
  - Rationale: works offline, avoids native addon ABI issues, simplest cross-platform distribution path (single binary).

**Task 2.1 — Rust `scan` command (filesystem accounting)**
- Goal: compute logical/physical size for large trees with hardlink-aware dedup.
- Inputs: `--root <path>` (directory), optional `--follow-symlinks <true|false>` (default false).
- Output: JSON `kind: "better.scan.report"`, stable key order.
- Files:
  - `crates/better-core/src/main.rs` (arg parsing + command router)
  - `crates/better-core/src/scan.rs` (walk + stats)
- Edge cases:
  - Symlinks: do not follow by default; count symlink entry as 0 bytes, 1 file.
  - Hardlinks: best-effort physical bytes; if file identity cannot be derived (Windows quirks), set `physicalBytesApprox: true`.
- Acceptance:
  - On macOS/Linux: physicalBytes <= logicalBytes; hardlinked duplicates reduce physicalBytes.
  - Deterministic output (sorted traversal).

**Task 2.2 — Rust `analyze` command (package discovery + sizes)**
- Goal: list packages by scanning `node_modules/**/package.json` plus size attribution (v0 = package dir total).
- Output: JSON `kind: "better.analyze.report"`, `schemaVersion` bump only on breaking changes.
- Files:
  - `crates/better-core/src/analyze.rs` (discover packages, compute per-package size)
  - `src/lib/analyzeFacade.js` (prefers core, falls back to JS)
- Acceptance:
  - On a fixture, output includes package `name`, `version`, `path`, and `size.{logical,physical}`.
  - Deterministic ordering.

**Task 2.3 — Wire core into `better doctor`**
- Goal: reuse analyze output to compute health score without re-scanning twice.
- Files:
  - `src/commands/doctor.js` (consume analysis report)
  - `src/lib/core.js` (binary locator + invocation; env override via `BETTER_CORE_PATH`)
- Acceptance:
  - `better doctor --json` uses core when available and still works without it.

**Task 2.4 — Distribution + build ergonomics**
- Goal: make local dev and CI build predictable.
- Files:
  - `package.json` scripts: `core:build`, `core:build:debug`
  - `test/core-integration.test.js` builds core and validates JSON.
- Acceptance:
  - `npm test` passes on macOS/Linux; Windows runs with relaxed physical-bytes guarantees.

### Phase 3 — npm lockfile replay (materializer, experimental)
Deliver:
- parse `package-lock.json` v2/v3
- fetch+verify tarballs to CAS
- materialize node_modules (copy/hardlink/reflink)
- script handling v0: “run scripts via npm” fallback for scriptful packages

Acceptance:
- for a curated fixture suite, `node -e "require('x')"` passes for direct deps
- `npm test` passes on 2 real projects using `--engine better --experimental`

#### Phase 3 — Detailed implementation tasks (decision complete)

**Design contract (non-negotiable)**
- Better engine **does not resolve** versions. It only **replays** an existing lockfile.
- If lockfile is missing fields required for verification, behavior is explicit via `--verify` modes.

**Task 3.1 — CAS + integrity verification**
- Store tarballs by `integrity` digest (`sha512` preferred).
- Refuse install when `--verify integrity-required` and any `integrity` is missing or fails.
- Files:
  - `src/engine/better/ssri.js`, `src/engine/better/cas.js`
  - `src/lib/cache.js` (ensures CAS dirs are writable; fallback to `.better/cache` when needed)
- Acceptance:
  - Tampering a tarball causes install to fail with a clear error.

**Task 3.2 — Materialize `node_modules` with safe linking**
- Strategy priority:
  1) reflink (future; OS support detection)
  2) hardlink
  3) copy
- Files:
  - `src/engine/better/materialize.js`
  - `src/commands/install.js` flags: `--link-strategy auto|hardlink|copy`
- Acceptance:
  - Hardlink mode reduces physical size on repeated installs.

**Task 3.3 — Script/native addon safety**
- Default `--scripts rebuild` runs `npm rebuild --no-audit --no-fund` after materialize.
- `--scripts off` skips it completely (for CI sanity / debugging).
- Files:
  - `src/engine/better/installBetterNpm.js`
- Acceptance:
  - Native addon fixture works with `--scripts rebuild` and fails (expected) with `--scripts off`.

**Task 3.4 — `.bin` links v0**
- Root-only `.bin` links are created after atomic swap.
- Files:
  - `src/engine/better/bins.js`
- Acceptance:
  - For packages with `bin`, `node_modules/.bin/<name>` exists on macOS/Linux; `.cmd` shim on Windows.

### Phase 4 — Workspaces + remote cache
Deliver:
- workspace traversal and per-workspace lockfile semantics
- `cache export/import` + CI artifact integration examples

Acceptance:
- cold CI install time reduced by >50% on 2 monorepos

#### Phase 4 — Detailed implementation tasks (decision complete)

**Task 4.1 — npm workspaces: `link:true` support (root node_modules)**
- Support `package-lock.json` v2/v3 entries like:
  - workspace metadata at keys like `packages/foo`
  - `node_modules/<ws>` entries with `{ link: true, resolved: "packages/foo" }`
- Files:
  - `src/engine/better/npmLockfile.js` (workspace entry listing + detection)
  - `src/engine/better/installBetterNpm.js` (symlink/junction materialization)
  - `test/better-engine.test.js` (workspace fixture)
- Acceptance:
  - `require('<workspace>')` works from repo root after `better install --engine better --experimental`.
- Known limitation (explicit error):
  - Non-root install paths like `packages/*/node_modules/*` are not supported until Task 4.2.

**Task 4.2 — npm workspaces: non-root `*/node_modules/*` install paths**
- Support lock keys containing `/node_modules/` under workspace directories without mutating workspace source trees.
- Implementation approach:
  - Create **multiple staging dirs** per unique node_modules root:
    - root: `<root>/.better-staging-node_modules-*`
    - workspace: `<root>/.better-staging-<wsPath>-node_modules-*`
  - After staging, atomically swap each corresponding `node_modules` directory independently.
- Acceptance:
  - A fixture with a workspace-local dep passes `require()` from within workspace.

**Task 4.3 — Remote cache UX**
- Improve `better cache export/import`:
  - `--scope store|pm|all` (default `store`)
  - write a `manifest.json` with schemaVersion + byte counts
  - deterministic tar ordering
- Add CI examples:
  - GitHub Actions cache keys based on lockfile hash + platform
  - Optional artifact upload/download
- Acceptance:
  - `better cache export --scope store` then `import` reproduces installs offline for fixture.

### Phase 5 — pnpm/yarn lockfile replay + PnP (research → product)
Deliver:
- pnpm lockfile replay is prioritized before Yarn PnP
- PnP introduced as a targeted mode for compatible repos

Acceptance:
- compatibility matrix published; PnP recommended only when checks pass

#### Phase 5 — Detailed implementation tasks (decision complete)

**Task 5.1 — pnpm lockfile replay (materialize-only)**
- Goal: materialize a pnpm-style content-addressed store into `node_modules` without changing resolution.
- Approach:
  - Treat pnpm as the canonical resolver; Better reads `pnpm-lock.yaml` plus pnpm store metadata.
  - Phase 5.1a (fast win): “pnpm as resolver” mode — run pnpm to produce store, then hardlink into project.
- Acceptance:
  - `better install --engine pm --pm pnpm` + Better measurement matches baseline and reports reuse.

**Task 5.2 — Yarn Berry PnP (targeted mode)**
- Goal: reduce `node_modules` to near-zero where compatible.
- Constraints:
  - Only opt-in (`better install --mode pnp`) with explicit compatibility checks.
  - Provide “escape hatch” to revert to `node_modules` mode.
- Acceptance:
  - Published compatibility matrix + `better doctor` check that explains why PnP is/isn’t safe.

---

## Testing Strategy (Non-negotiable)

### Fixtures (repo-contained)
- npm lockfile v2 + v3
- pnpm v9
- yarn classic + berry
- scriptful package fixture
- native addon fixture
- optional deps fixture (os/cpu filters)

### Parity tests
For each fixture:
- install with reference PM
- install with Better engine (bun/better)
- compare:
  - package set hash
  - lockfile drift
  - runtime smoke tests

### Cross-platform
CI on macOS + Linux + Windows:
- file identity correctness
- hardlink/reflink fallbacks
- path length and symlink permissions

---

## Risks & Mitigations

1) **Bun engine semantic drift** → default off; parity checks; explicit warning; easy rollback to `--engine pm`.
2) **Scripts mutate shared content** → isolate scriptful packages; separate build cache; strong provenance logging.
3) **Windows linking constraints** → capability detection + copy fallback; avoid symlink dependence by default.
4) **Scope creep to full resolver** → keep “lockfile replay” as the stable contract; resolver is a separate future track.

---

## Definition of Done (vNext milestone)

Better is “Bun-like incremental toolkit” when:
- `better install --engine pm` is trusted, measurable, and stable
- `better install --engine bun` is fast and honest (parity checked)
- `better analyze` and `better doctor` are fast on very large repos (Rust core)
- `better cache` clearly explains space/reuse and safely GC’s

---

## Implementation Order (What to execute first)

Follow this order to maximize early wins without painting ourselves into a corner:

1) **Phase 1:** Bun engine + parity checks (`better install --engine bun`)
2) **Phase 2:** Rust core for `analyze/doctor` (fast on huge repos)
3) **Phase 3:** npm lockfile replay materializer + CAS (experimental)
4) **Phase 4:** workspaces + remote cache (CI + portability)
5) **Phase 5:** pnpm/yarn replay + PnP (targeted)

---

## Plan Files: Which to follow, in what order?

Use the plan files as follows:

1) **`.omc/plans/better-vnext.md` (this file)** — master execution plan and product contract.
2) **`.omc/plans/better-npm.md`** — reference for “safe wrapper-first” behavior and guardrails.
3) **`.omc/plans/better-rust-rewrite.md`** — reference for Rust core tasks (scanning/size/graph), but follow the revised scope (acceleration + materializer track).

PLAN_READY: .omc/plans/better-vnext.md
