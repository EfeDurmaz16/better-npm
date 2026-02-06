# Better JSON Schemas (MVP)

This document defines the stable JSON envelopes emitted by Better commands.

## Common conventions

- `ok`: boolean success flag.
- `kind`: report identifier.
- `schemaVersion`: integer schema version.
- Timestamps are ISO-8601 UTC strings.
- Human logs are emitted to stderr as NDJSON and should not be parsed from stdout payloads.

## `better install --json`

`kind: "better.install.report"`, `schemaVersion: 2`

Core fields:

- `runId`, `startedAt`, `endedAt`
- `projectRoot`
- `pm`: `{ name, detected, reason }`
- `engine`, `mode`, `lockfilePolicy`
- `command`: `{ cmd, args }`
- `install.wallTimeMs`
- `install.metrics`:
  - `durationMs`
  - `packagesBefore`, `packagesAfter`, `packagesInstalled`
  - `logicalBytesBefore`, `logicalBytesAfter`, `logicalBytesDelta`
  - `physicalBytesBefore`, `physicalBytesAfter`, `physicalBytesDelta`
  - `cache`: `{ hits, misses, source }`
- `nodeModules`: size and file/package counts
- `cache.before` / `cache.after`: PM cache size snapshots
- `cacheDecision`:
  - `enabled`, `eligible`, `hit`, `reason`
  - `key`, `pmSupportPhase`
  - `mode`, `readOnly`
- `materialize` (when global materialization path is used)
- `reuse` (reuse-oriented byte counters)
- `betterEngine` (when `engine=better`), including extract/cache details and `skipped.platform`
- `parity` (optional)
- `lockfileMigration` (optional)
- `baseline`

## `better install --dry-run --json`

`kind: "better.install.dryrun"`, `schemaVersion: 1`

Core fields:

- `dryRun: true`
- `pm`, `engine`, `command`
- `estimate`:
  - lockfile metadata and estimated package count
  - node_modules pre-state metrics

## `better analyze --json`

`kind: "better.analyze.report"`, `schemaVersion: 2`

Core fields:

- `projectRoot`
- `nodeModules`: logical/physical bytes + file count
- `packages`: package list with per-package sizes, paths, and manifest dependency keys
- `depth`: `{ maxDepth, p95Depth }`
- `summary`:
  - `totalPackages`
  - `directDependencies`
  - `directPackagesInstalled`
  - `transitivePackages`
  - `logicalSizeBytes`, `physicalSizeBytes`
  - `maxDepth`
  - `longestChain` (`name@version` keys)
- `duplicatesDetailed`: duplicate packages with versions, counts, and paths
- `deprecated`: `{ totalDeprecated, packages[] }`
- `largestPackages`: top packages by physical size

## `better doctor --json`

`kind: "better.doctor"`, `schemaVersion: 2`

Core fields:

- `projectRoot`
- `healthScore`:
  - `score`, `threshold`, `maxScore`
  - `deduction`
  - `belowThreshold`
- `findings[]` with:
  - `id`, `title`, `severity` (`error|warning|info`)
  - `impact` (score deduction)
  - `recommendation`
  - `details`
- `findingsBySeverity`
- `checks` summary booleans/counts
- `securityAudit` (best-effort advisory scan result)
- `fixes` (when `--fix` is used)

Exit behavior:

- non-zero exit when `healthScore.score < threshold`

## `better cache stats --json`

`kind: "better.cache.stats"`, `schemaVersion: 2`

Core fields:

- `cacheRoot`
- `entries`: total, oldest/newest timestamps
- `sizes`: total and per-subtree bytes
- `hitRatio`: `{ hits, misses, ratio, sampledRuns }`
- `globalCache`: `{ entries, materializedProjects, gcPolicy }`
- `projects`
- `trackedPackages`

## `better cache gc --json`

`kind: "better.cache.gc"`, `schemaVersion: 2`

Core fields:

- `dryRun`
- `keepDays`
- `entriesRemoved`
- `bytesFreed`
- `deleted` item lists

## `better cache explain <target> --json`

`kind: "better.cache.explain"`, `schemaVersion: 2`

Core fields:

- `target`
- `package`: parsed package spec
- `keyDerivation`: deterministic key algorithm details
- `cached`: best-effort status
- `reason`
- `lookedUpPaths`
- `observedInProjects`
- `lastSeenAt`
- `globalCacheEntry` (when target matches a global cache key)
- `tracking` (when Better has package-level cache usage metadata)

## `better cache warm --json`

`kind: "better.cache.warm"`, `schemaVersion: 1`

Core fields:

- `projectRoot`
- `key`
- `status` (`already_warm|stored`)
- `durationMs` (when stored)
- `stats` (file/link/copy counters)

## `better cache materialize --json`

`kind: "better.cache.materialize"`, `schemaVersion: 1`

Core fields:

- `projectRoot`
- `key`
- `durationMs`
- `strategy`
- `stats`

## `better cache verify --json`

`kind: "better.cache.verify"`, `schemaVersion: 1`

Core fields:

- `projectRoot`
- `key`
- `ok`
- `reason`

## `better benchmark --json`

`kind: "better.benchmark"`, `schemaVersion: 1`

Core fields:

- `projectRoot`
- `pm`: selected + detected
- `engine`
- `config`: cold/warm rounds and run knobs
- `variants`:
  - `raw`, `betterMinimal`, optional `betterFull`
  - each includes `cold[]`, `warm[]`, and `stats` (`min|max|mean|median|p95`)
- `comparison`:
  - `rawWarmMedianMs`
  - `betterWarmMedianMs`
  - `deltaMs`, `deltaPercent`
  - `wrapperTaxMs`

## `better serve --json`

`kind: "better.serve"`, `schemaVersion: 1`

Core fields:

- `ok`
- `projectRoot`
- `port` (actual bound port; supports dynamic port selection with `--port 0`)
- `url`
