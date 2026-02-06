# Comparative Benchmark Report: `better` vs raw `bun`

Date: 2026-02-06
Project: `/Users/efebarandurmaz/Desktop/aspendos-deploy`

## Command

```bash
better benchmark --pm npm --engine bun --cold-rounds 1 --warm-rounds 5 --json > benchmark-bun.json
```

`--engine bun` mode compares:

- `raw`: direct `bun install`
- `betterMinimal`: `better install` wrapper running bun with minimal measurement profile

## Warm Results (from `benchmark-bun.json`)

### Raw (`bun install`)

- count: 5
- min: 11337 ms
- max: 24481 ms
- mean: 18569 ms
- median: 18346 ms
- p95: 24481 ms

### Better Minimal (`better install --engine bun`)

- count: 5
- min: 9420 ms
- max: 18840 ms
- mean: 12027.4 ms
- median: 10621 ms
- p95: 18840 ms

## Delta (Warm)

- median delta: `10621 - 18346 = -7725 ms` (about `-42.1%`)
- mean delta: `12027.4 - 18569 = -6541.6 ms` (about `-35.2%`)
- p95 delta: `18840 - 24481 = -5641 ms` (about `-23.0%`)

## Interpretation

- In this run profile, `betterMinimal` is faster than raw bun in warm rounds.
- Tail latency (p95) is also better, indicating more stable repeated installs.
- For publish-grade comparison, repeat with `cold-rounds >= 3` and `warm-rounds >= 10`, then report median and p95 as primary metrics.
