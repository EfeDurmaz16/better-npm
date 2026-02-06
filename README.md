# better

Dependency toolkit for Node.js projects.

This repo currently implements an MVP CLI with five primary commands:

- `better install` — wraps `npm`/`pnpm`/`yarn`, wires a shared cache root, and measures `node_modules` logical vs physical size
- `better analyze` — deterministic `node_modules` attribution + duplication/depth/deprecation detection, JSON output, and a local UI (`--serve`)
- `better cache` — `stats`, `gc`, `explain` for the Better-managed cache roots and run artifacts
- `better doctor` — rule-based checks + explainable 0–100 health score
- `better benchmark` — comparative cold/warm rounds (raw PM vs Better) with median/p95 summary

Global cache primitives are available behind opt-in flags:

- `better install --global-cache` — strict keying + reusable materialized `node_modules`
- `better cache warm` / `materialize` / `verify` — operational control for global materialization entries

Replay-engine optimizations now include:

- same-key local no-op reuse marker (`node_modules/.better-state.json`)
- incremental replay materialization (`--no-incremental` to disable)
- tunable filesystem concurrency (`--fs-concurrency N`)
- runtime selector scaffold (`--core-mode auto|js|rust`, JS fallback by default)

## Usage

From a Node.js project directory:

```bash
node /path/to/better/bin/better.js install
node /path/to/better/bin/better.js analyze --serve
node /path/to/better/bin/better.js doctor
node /path/to/better/bin/better.js cache stats
node /path/to/better/bin/better.js benchmark --pm npm --engine pm --cold-rounds 1 --warm-rounds 3
```

## Landing app (Next.js + Geist fonts)

A Vercel-ready React/Next landing app now lives at `apps/landing`.

- Stack: Next.js App Router + TypeScript
- Fonts: Geist Sans, Geist Mono, Geist Pixel (npm package `geist`)
- Includes current benchmark framing from live measurements

Run locally:

```bash
cd apps/landing
npm install
npm run dev
```

Use Better before build/lint:

```bash
cd apps/landing
npm run build:better
npm run lint:better
```

## Comparative benchmarks (2026-02-06)

The numbers below come from live runs on two real projects:

- `sardis-protocol`
- `aspendos-deploy`

### Results snapshot

| Scenario | Baseline | Better run | Delta |
| --- | ---: | ---: | ---: |
| Sardis: `npm cold` vs `better warm hit (rust cache)` | 16.65s | 6.81s | **-59.1%** |
| Sardis: `better warm hit (js)` vs `better warm hit (rust)` | 8.31s | 6.81s | **-22.0%** |
| Aspendos: `raw bun` vs `better + bun wrapper` | 96.02s | 15.25s | **-84.1%** |
| Sardis: `raw bun` vs `better + bun wrapper` | 2.03s | 2.03s | parity |

### Cache behavior snapshot

- Global cache is active (`cacheDecision.reason = global_cache_hit` on warm runs).
- Hardlink materialization is active (`filesLinked = 23509`, `filesCopied = 0`).
- Cold miss (first capture) is still expensive because it includes replay + capture write.
- Warm hit is where Better currently wins decisively.

### How to reproduce

Build the Rust core first:

```bash
npm run core:build
```

Sardis (`npm` baseline vs Better global-cache warm-hit):

```bash
SA=/Users/efebarandurmaz/sardis-protocol
BETTER_BIN=/Users/efebarandurmaz/better-npm/bin/better.js
CACHE_ROOT=/tmp/better-gcache-local

rm -rf "$SA/node_modules" "$CACHE_ROOT"
/usr/bin/time -p npm install --ignore-scripts --no-audit --no-fund

rm -rf "$SA/node_modules"
/usr/bin/time -p node "$BETTER_BIN" install \
  --project-root "$SA" --pm npm --engine better --experimental \
  --core-mode rust --global-cache --cache-root "$CACHE_ROOT" \
  --link-strategy hardlink --scripts off --cache-scripts off \
  --measure off --parity-check off --json > /tmp/better-miss.json

rm -rf "$SA/node_modules"
/usr/bin/time -p node "$BETTER_BIN" install \
  --project-root "$SA" --pm npm --engine better --experimental \
  --core-mode rust --global-cache --cache-root "$CACHE_ROOT" \
  --link-strategy hardlink --scripts off --cache-scripts off \
  --measure off --parity-check off --json > /tmp/better-hit.json
```

Aspendos (`raw bun` vs `better --engine bun`):

```bash
ASP=/Users/efebarandurmaz/Desktop/aspendos-deploy
BETTER_BIN=/Users/efebarandurmaz/better-npm/bin/better.js

rm -rf "$ASP/node_modules"
/usr/bin/time -p bun install --frozen-lockfile

rm -rf "$ASP/node_modules"
/usr/bin/time -p node "$BETTER_BIN" install \
  --project-root "$ASP" --pm npm --engine bun --frozen \
  --measure off --parity-check off --json > /tmp/better-bun.json
```

### Interpretation

- Better is not yet universally faster in **cold miss** mode.
- Better is already strong in:
  - global cache **warm hit** materialization
  - no-op reuse paths
  - bun wrapper flow on large repos (aspendos case)
- The landing page benchmark panel is synced with this snapshot in `src/web/public/landing.html`.

## JSON schemas

Stable report envelopes are documented in `docs/json-schemas.md`.

## Quality gates

The repository includes dependency-free quality scripts:

```bash
npm run lint
npm run format:check
npm run coverage
```

`npm run coverage` enforces a minimum 80% line-coverage average for Better core modules.

If you install/publish this as a package later, you’ll use:

```bash
better install
```

## Cache root

By default Better uses an OS cache directory. If that path isn’t writable, it falls back to a project-local cache at `.better/cache`.

Override explicitly via:

```bash
better cache stats --cache-root /some/path
```
