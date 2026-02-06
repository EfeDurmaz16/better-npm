# Comparative Benchmark Report: Better vs npm/bun

Date: 2026-02-06

## Summary

| Project | Comparison | Baseline | Better | Delta |
| --- | --- | ---: | ---: | ---: |
| `aspendos-deploy` | raw bun vs `better --engine bun` | 96.02s | 15.25s | **-84.1%** |
| `sardis-protocol` | npm cold vs Better warm hit (rust cache materialize) | 16.65s | 6.81s | **-59.1%** |
| `sardis-protocol` | Better warm hit JS vs Rust runtime | 8.31s | 6.81s | **-22.0%** |
| `sardis-protocol` | raw bun vs `better --engine bun` | 2.03s | 2.03s | parity |

## Projects and commands

### Aspendos (`/Users/efebarandurmaz/Desktop/aspendos-deploy`)

```bash
rm -rf node_modules
/usr/bin/time -p bun install --frozen-lockfile

rm -rf node_modules
/usr/bin/time -p node /Users/efebarandurmaz/better-npm/bin/better.js install \
  --project-root /Users/efebarandurmaz/Desktop/aspendos-deploy \
  --pm npm --engine bun --frozen --measure off --parity-check off --json \
  > /tmp/cmp_aspendos_better_bun.json
```

### Sardis (`/Users/efebarandurmaz/sardis-protocol`)

```bash
rm -rf node_modules
/usr/bin/time -p npm install --ignore-scripts --no-audit --no-fund

rm -rf node_modules
/usr/bin/time -p node /Users/efebarandurmaz/better-npm/bin/better.js install \
  --project-root /Users/efebarandurmaz/sardis-protocol \
  --pm npm --engine better --experimental --core-mode rust \
  --global-cache --cache-root /tmp/better-gcache-compare \
  --link-strategy hardlink --scripts off --cache-scripts off \
  --measure off --parity-check off --json > /tmp/cmp_better_hit_rust.json
```

## Key observations

- Better’s strongest advantage is **global-cache warm hit** + hardlink materialization.
- Cache hit materialization reports:
  - `filesLinked: 23509`
  - `filesCopied: 0`
  - `execution.mode: cache_materialize`
- Cold miss includes replay + initial global cache capture, so it remains the main optimization target.

## Raw report references

- `/tmp/compare-current-summary.json`
- `/tmp/compare-sardis-after-capture-rust.json`
