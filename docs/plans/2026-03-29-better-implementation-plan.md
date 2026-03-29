# better — Complete Implementation Plan (v0.2 → v2.0)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the universal package manager — fastest, smartest, most secure — with native Sardis/OSP integration for the agent economy.

**Architecture:** Rust core with engine trait system. JS thin CLI wrapper via NAPI or subprocess. Universal CAS at `~/.better/cas/`. Binary + JSON sidecar lockfile. Plugin system via WASM/dylib.

**Tech Stack:** Rust (core engine, resolution, fetch, CAS, audit), Node.js (CLI wrapper, NAPI bridge), reqwest (HTTP/2), rayon (parallelism), serde (serialization), clap (Rust CLI), Ed25519/X25519 (crypto).

**Total scope:** 128 features, 15 versions, ~121 implementation tasks

**Note:** Detailed TDD-level plans for each version will be written in separate documents as each version begins implementation.

---

## Dependency Graph Between Versions

```
v0.2 Foundation
  |-> v0.3 Speed + Core (depends on: CI/CD, npm publish, Rust module split)
        |-> v0.4 Intelligence (depends on: engine trait, better.lock)
              |-> v0.5 Enterprise (depends on: smart audit, strict isolation)
                    |-> v0.6 Universal Python (depends on: engine trait system)
                          |-> v0.7 Agentic (depends on: JSON output, multi-ecosystem)
                                |-> v0.8 Sardis + OSP (depends on: agent mode, MCP server)
                                      |-> v0.9 Ecosystems (depends on: engine trait, plugin system)
                                            |-> v1.0 Launch (depends on: all above stable)
                                                  |-> v1.1 Mobile + Ruby
                                                  |-> v1.2 PHP + .NET + CI
                                                  |-> v1.3 Decentralized
                                                  |-> v1.4 Deploy + Infra
                                                  |-> v1.5 Intelligence v2
                                                  |-> v2.0 AI-Native
```

v1.1-v2.0 can be parallelized as independent feature branches off v1.0.

---

## v0.2 — Foundation (10 tasks, ~35 commits)

See: `docs/plans/2026-03-29-v0.2-foundation.md`

## v0.3 — Speed + Core (13 tasks, ~55 commits)

See: `docs/plans/2026-03-29-v0.3-speed-core.md`

## v0.4 — Intelligence (8 tasks, ~30 commits)

See: `docs/plans/2026-03-29-v0.4-intelligence.md`

## v0.5 — Enterprise (7 tasks, ~35 commits)

See: `docs/plans/2026-03-29-v0.5-enterprise.md`

## v0.6 — Universal Python (8 tasks, ~40 commits)

See: `docs/plans/2026-03-29-v0.6-universal-python.md`

## v0.7 — Agentic (9 tasks, ~35 commits)

See: `docs/plans/2026-03-29-v0.7-agentic.md`

## v0.8 — Sardis + OSP (16 tasks, ~60 commits)

See: `docs/plans/2026-03-29-v0.8-sardis-osp.md`

## v0.9 — Ecosystems (10 tasks, ~40 commits)

See: `docs/plans/2026-03-29-v0.9-ecosystems.md`

## v1.0 — Launch (10 tasks, ~30 commits)

See: `docs/plans/2026-03-29-v1.0-launch.md`

## v1.1 — Mobile + Ruby (6 tasks, ~25 commits)

See: `docs/plans/2026-03-29-v1.1-mobile-ruby.md`

## v1.2 — PHP + .NET + CI (6 tasks, ~25 commits)

See: `docs/plans/2026-03-29-v1.2-php-dotnet-ci.md`

## v1.3 — Decentralized (6 tasks, ~30 commits)

See: `docs/plans/2026-03-29-v1.3-decentralized.md`

## v1.4 — Deploy + Infra (6 tasks, ~25 commits)

See: `docs/plans/2026-03-29-v1.4-deploy-infra.md`

## v1.5 — Intelligence v2 (6 tasks, ~25 commits)

See: `docs/plans/2026-03-29-v1.5-intelligence-v2.md`

## v2.0 — AI-Native (7 tasks, ~30 commits)

See: `docs/plans/2026-03-29-v2.0-ai-native.md`

---

**Total estimated commits: ~540**
**Total implementation tasks: ~121**
