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

## Usage

From a Node.js project directory:

```bash
node /path/to/better/bin/better.js install
node /path/to/better/bin/better.js analyze --serve
node /path/to/better/bin/better.js doctor
node /path/to/better/bin/better.js cache stats
node /path/to/better/bin/better.js benchmark --pm npm --engine pm --cold-rounds 1 --warm-rounds 3
```

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
