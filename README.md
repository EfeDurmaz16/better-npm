# better

A faster, smarter package manager for Node.js — built on a pure Rust core.

## Performance

Benchmarked on a real project with 15 dependencies (145 resolved packages):

| Tool | Warm Install | Cold Install |
|------|------------:|-------------:|
| **better** | **75ms** | ~400ms |
| bun | 198ms | ~500ms |
| npm | 1,749ms | ~8,000ms |

**2.6x faster than bun. 23x faster than npm.**

### How it works

- **Pure Rust binary** — zero Node.js startup overhead (saves ~265ms vs JS-based tools)
- **macOS clonefile()** — APFS copy-on-write for near-instant directory materialization
- **Parallel everything** — rayon-powered resolution, fetch, extract, and materialize
- **Content-addressable store** — SHA-512 package cache + SHA-256 file-level dedup
- **3-tier materialize** — clonefile -> CAS hardlinks -> copy fallback

### Cross-project dedup (`--dedup`)

Share `node_modules` files across projects via hardlinks from a global store:

```bash
better install --dedup
```

| Projects | Without dedup | With --dedup | Savings |
|----------|-------------:|-------------:|--------:|
| 2 | 28MB | ~16MB | 43% |
| 5 | 70MB | ~18MB | 74% |
| 10 | 140MB | ~20MB | 86% |

Files share the same inode across projects — editing one won't affect others (copy-on-write at the filesystem level).

**Trade-off:** `--dedup` takes ~515ms (vs ~75ms default) because it hardlinks individual files instead of cloning entire directories. Default mode opportunistically ingests to CAS so `--dedup` is ready when you need it.

## Install

Build the Rust core:

```bash
cd crates && cargo build --release -p better-core
```

### Rust binary (fastest)

```bash
./crates/target/release/better-core install --project-root /path/to/project
```

### Node.js CLI (full feature set)

```bash
node bin/better.js install
```

The JS CLI automatically detects and uses the Rust binary when available, falling back to the JS pipeline otherwise. Disable with `BETTER_NO_RUST_BINARY=1`.

## Commands

### Core

```bash
better install              # Install dependencies (auto-selects fastest strategy)
better install --dedup      # Install with cross-project file dedup
better install --no-scripts # Skip lifecycle scripts
better analyze              # Dependency attribution, duplicates, depth analysis
better doctor               # Health score (0-100) with actionable rules
better benchmark            # Comparative timing across package managers
```

### Cache

```bash
better cache stats          # Cache size, hit rates, storage breakdown
better cache gc             # Garbage collect unreferenced entries
```

### Utilities

```bash
better run <script>         # Run package.json scripts
better lock                 # Generate deterministic lock metadata
better audit                # Security vulnerability scan
```

## Architecture

```
bin/better.js          CLI entry point (Node.js)
src/
  cli.js               Command router (17 commands)
  engine/better/       JS install engine (fallback)
  lib/core.js          Rust binary bridge
crates/
  better-core/         Pure Rust binary
    src/lib.rs          Core library (resolve, fetch, materialize, CAS, bin links)
    src/main.rs         CLI binary (install, analyze, scan, materialize)
  better-napi/         Node.js native addon (NAPI bridge)
apps/
  landing/             Next.js landing page
```

## Development

```bash
# Build Rust core
cd crates && cargo build --release -p better-core

# Run tests
node --test test/better-engine.test.js

# Lint & format
npm run lint
npm run format:check
```

## License

MIT
