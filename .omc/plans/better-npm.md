# Better: Dependency Toolkit Implementation Plan (Wrapper-First)

> A production-grade CLI toolkit for Node.js that makes dependency management measurable, explainable, observable, and shareable.

---

## Plan Status (2026-02-04)

This plan describes the **wrapper-first** implementation path and remains valid for the “safe default” engine.

For the expanded vNext direction (Bun engine + Rust core acceleration + Better materializer), see:
- `.omc/plans/better-vnext.md`

Key updates to align with vision:
- Online checks (deprecated/security) must be **explicit opt-in** to preserve determinism.
- Auto-fix (`doctor --fix`) is **deferred** unless it can be proven semantics-safe; prefer “suggest exact commands”.
- Add an opt-in install engine: `better install --engine bun` with **parity checks** and lockfile policy.

## Executive Summary

**Better** wraps existing package managers (npm/pnpm/yarn) with a shared cache layer, deep measurement capabilities, and health diagnostics. The MVP delivers four core commands: `install`, `analyze`, `cache`, and `doctor`.

### Core Design Principles

1. **Non-invasive**: Wrap, don't replace - preserve existing resolution semantics
2. **Measurable**: Every operation produces metrics (size, time, cache hits)
3. **Explainable**: Every decision can be traced and understood
4. **Observable**: NDJSON logs, optional OpenTelemetry, JSON outputs
5. **Cross-platform**: macOS, Linux, Windows support from day one

---

## Requirements Summary

### Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-1 | Detect and wrap npm, pnpm, yarn (Classic + Berry) | P0 |
| FR-1b | Opt-in Bun engine with parity checks | P1 |
| FR-2 | Maintain shared Better cache across projects | P0 |
| FR-3 | Calculate logical size (sum of file bytes) | P0 |
| FR-4 | Calculate physical size (hardlink-aware) | P0 |
| FR-5 | Generate dependency graph from node_modules | P0 |
| FR-6 | Detect duplicate packages (same name, different versions) | P0 |
| FR-7 | Compute Health Score (0-100) with itemized findings | P0 |
| FR-8 | Output all data as JSON for tooling integration | P0 |
| FR-9 | Serve local web UI for visual analysis | P1 |
| FR-10 | Garbage collect stale cache entries | P1 |
| FR-11 | Explain cache decisions (why cached, why not) | P1 |
| FR-12 | Materialize mode (experimental, opt-in) | P2 |

### Non-Functional Requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-1 | Node.js 20+ LTS | Required |
| NFR-2 | TypeScript strict mode | Required |
| NFR-3 | Zero runtime dependencies where possible | Goal |
| NFR-4 | CLI startup time | < 100ms |
| NFR-5 | Scan 10k files | < 5s |
| NFR-6 | Test coverage | > 80% |

---

## Acceptance Criteria

### Phase 0: Foundations
- [ ] `better --version` prints version and exits 0
- [ ] `better --help` shows all commands with descriptions
- [ ] Config loaded from `better.config.js`, `.betterrc`, or `package.json#better`
- [ ] Correct package manager detected from lockfile (package-lock.json, pnpm-lock.yaml, yarn.lock)
- [ ] Cache root created at `~/.better/cache` (or XDG_CACHE_HOME)
- [ ] NDJSON logging to stderr with `--log-level` flag
- [ ] `--json` flag outputs structured JSON to stdout

### Phase 1: better install MVP
- [ ] `better install` invokes detected package manager's install
- [ ] Install time measured and reported
- [ ] Cache hits/misses tracked (preparation for future cache wiring)
- [ ] Exit code matches underlying package manager
- [ ] `--dry-run` shows what would happen without executing

### Phase 2: Analyzer MVP
- [ ] `better analyze` scans node_modules recursively
- [ ] Reports: total packages, logical size, physical size
- [ ] Detects and lists duplicate packages with versions
- [ ] Calculates max dependency depth
- [ ] Identifies deprecated packages (from package.json#deprecated)
- [ ] `--json` outputs full analysis as JSON
- [ ] `--serve` launches local web UI on available port

### Phase 3: Doctor + Health Score
- [ ] `better doctor` runs all health checks
- [ ] Health Score computed (0-100) with weighted deductions
- [ ] Findings categorized: error, warning, info
- [ ] Actionable recommendations for each finding
- [ ] `--fix` attempts automatic fixes where safe
- [ ] Exit code non-zero if score < threshold (default 70)

---

## Project Structure

```
better-npm/
├── .github/
│   └── workflows/
│       ├── ci.yml              # Test + lint on PR
│       └── release.yml         # Publish to npm
├── src/
│   ├── index.ts                # CLI entry point
│   ├── cli/
│   │   ├── commands/
│   │   │   ├── install.ts
│   │   │   ├── analyze.ts
│   │   │   ├── cache.ts
│   │   │   └── doctor.ts
│   │   ├── parser.ts           # Argument parsing
│   │   └── output.ts           # JSON/text formatters
│   ├── config/
│   │   ├── loader.ts           # Config file discovery
│   │   ├── schema.ts           # Zod schema for config
│   │   └── defaults.ts
│   ├── adapters/
│   │   ├── base.ts             # Abstract PackageManagerAdapter
│   │   ├── npm.ts
│   │   ├── pnpm.ts
│   │   ├── yarn-classic.ts
│   │   └── yarn-berry.ts
│   ├── cache/
│   │   ├── manager.ts          # Cache operations
│   │   ├── metadata.ts         # SQLite metadata store
│   │   └── gc.ts               # Garbage collection
│   ├── fs/
│   │   ├── scanner.ts          # Directory traversal
│   │   ├── size.ts             # Size calculations
│   │   └── hardlinks.ts        # Hardlink detection
│   ├── analyzer/
│   │   ├── graph.ts            # Dependency graph builder
│   │   ├── duplicates.ts       # Duplicate detection
│   │   ├── depth.ts            # Depth analysis
│   │   └── deprecation.ts      # Deprecation checker
│   ├── doctor/
│   │   ├── engine.ts           # Health check runner
│   │   ├── score.ts            # Score calculator
│   │   ├── checks/
│   │   │   ├── duplicates.ts
│   │   │   ├── outdated.ts
│   │   │   ├── deprecated.ts
│   │   │   ├── security.ts
│   │   │   └── size.ts
│   │   └── fixes/
│   │       └── dedupe.ts
│   ├── ui/
│   │   ├── server.ts           # Local HTTP server
│   │   └── public/             # Static assets (built separately)
│   ├── observability/
│   │   ├── logger.ts           # NDJSON logger
│   │   └── telemetry.ts        # Optional OTEL
│   └── utils/
│       ├── platform.ts         # OS detection
│       ├── paths.ts            # XDG paths
│       └── spawn.ts            # Child process helpers
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
├── ui/                         # Separate UI package
│   ├── src/
│   ├── package.json
│   └── vite.config.ts
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── .eslintrc.cjs
├── .prettierrc
└── README.md
```

---

## Implementation Plan

### Phase 0: Foundations (Days 1-3)

#### Task 0.1: Project Scaffolding
**Files**: `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`

**Steps**:
1. Initialize package.json with name `better`, bin entry `better`
2. Configure TypeScript with strict mode, ES2022 target, NodeNext module
3. Set up tsup for dual CJS/ESM build with CLI shebang
4. Configure vitest with coverage thresholds
5. Add ESLint + Prettier with recommended configs
6. Create `.github/workflows/ci.yml` for automated testing

**Acceptance**: `pnpm build && ./dist/cli.js --version` outputs version

---

#### Task 0.2: CLI Framework
**Files**: `src/index.ts`, `src/cli/parser.ts`, `src/cli/output.ts`

**Steps**:
1. Implement minimal argument parser (no dependencies, inspired by mri/arg)
2. Support global flags: `--help`, `--version`, `--json`, `--log-level`, `--config`
3. Implement command routing: `better <command> [options]`
4. Create output formatter with JSON and human-readable modes
5. Handle unknown commands with helpful error messages

**Acceptance**:
- `better --help` shows all commands
- `better unknown` exits 1 with suggestion

---

#### Task 0.3: Configuration System
**Files**: `src/config/loader.ts`, `src/config/schema.ts`, `src/config/defaults.ts`

**Steps**:
1. Define config schema with Zod (inline, no external dep)
2. Search order: CLI flags > env vars > config file > defaults
3. Support config files: `better.config.js`, `.betterrc`, `package.json#better`
4. Validate and merge configs with type safety
5. Expose `getConfig()` singleton

**Config Schema**:
```typescript
interface BetterConfig {
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'auto';
  cacheDir?: string;
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  healthThreshold?: number; // 0-100
  telemetry?: boolean;
}
```

**Acceptance**: Config loaded from all sources with correct precedence

---

#### Task 0.4: Logger Implementation
**Files**: `src/observability/logger.ts`

**Steps**:
1. Create NDJSON logger with levels: debug, info, warn, error
2. Include timestamp, level, message, and arbitrary context
3. Respect `--log-level` flag and config
4. Output to stderr (stdout reserved for JSON output)
5. Add `--quiet` alias for `--log-level=error`

**Log Format**:
```json
{"ts":"2024-01-15T10:30:00.000Z","level":"info","msg":"Installing dependencies","pm":"npm"}
```

**Acceptance**: Logs filterable by level, parseable as NDJSON

---

#### Task 0.5: Package Manager Detection
**Files**: `src/adapters/base.ts`, `src/adapters/npm.ts`, `src/adapters/pnpm.ts`, `src/adapters/yarn-classic.ts`, `src/adapters/yarn-berry.ts`

**Steps**:
1. Define abstract `PackageManagerAdapter` interface:
   ```typescript
   interface PackageManagerAdapter {
     name: string;
     version: string;
     detect(): Promise<boolean>;
     install(args: string[]): Promise<ExecResult>;
     getCachePath(): string;
   }
   ```
2. Implement detection logic:
   - `package-lock.json` → npm
   - `pnpm-lock.yaml` → pnpm
   - `yarn.lock` + check `.yarnrc.yml` for Berry vs Classic
3. Verify package manager is installed (check version)
4. Create adapter factory: `detectPackageManager(cwd): Promise<Adapter>`

**Acceptance**: Correct adapter returned for each lockfile type

---

#### Task 0.6: Cache Root Setup
**Files**: `src/cache/manager.ts`, `src/utils/paths.ts`

**Steps**:
1. Determine cache root (XDG_CACHE_HOME or ~/.better/cache)
2. Create directory structure on first use
3. Implement cache path helpers: `getCachePath(type, key)`
4. Add `better cache stats` subcommand (placeholder)

**Directory Structure**:
```
~/.better/
├── cache/
│   ├── packages/       # Tarball cache
│   ├── metadata/       # Package metadata
│   └── db.sqlite       # Metadata database (future)
└── config/             # Global config (future)
```

**Acceptance**: Cache directory created with correct permissions

---

#### Task 0.7: Filesystem Accounting Engine
**Files**: `src/fs/scanner.ts`, `src/fs/size.ts`, `src/fs/hardlinks.ts`

**Steps**:
1. Implement async directory walker with configurable concurrency
2. Calculate logical size (sum of stat.size)
3. Detect hardlinks via inode tracking (stat.ino + stat.dev)
4. Calculate physical size (count hardlinked files once)
5. Handle symlinks appropriately (follow for size, track for reporting)
6. Cross-platform: handle Windows junction points

**Performance Target**: Scan 50k files in < 3 seconds

**Acceptance**:
- Logical size matches `du -sb`
- Physical size accounts for hardlinks

---

### Phase 1: better install MVP (Days 4-5)

#### Task 1.1: Install Command Implementation
**Files**: `src/cli/commands/install.ts`, `src/utils/spawn.ts`

**Steps**:
1. Parse install-specific flags: `--dry-run`, `--frozen`, `--production`
2. Detect package manager via adapter
3. Build command with appropriate flags
4. Execute with inherited stdio for interactive output
5. Capture timing metrics

**Acceptance**: `better install` behaves identically to native install

---

#### Task 1.2: Install Metrics Collection
**Files**: `src/cli/commands/install.ts`

**Steps**:
1. Record start/end time for total duration
2. Count packages before/after (node_modules scan)
3. Calculate size delta
4. Output metrics in `--json` mode:
   ```json
   {
     "duration": 12345,
     "packagesInstalled": 150,
     "sizeAdded": 52428800,
     "cacheHits": 0,
     "cacheMisses": 0
   }
   ```

**Acceptance**: Metrics output matches actual install behavior

---

#### Task 1.3: Dry Run Mode
**Files**: `src/cli/commands/install.ts`

**Steps**:
1. When `--dry-run`, don't execute install
2. Show what would be executed
3. If lockfile exists, estimate packages to install
4. Output as structured JSON when `--json` flag present

**Acceptance**: `better install --dry-run` shows command without executing

---

### Phase 2: Analyzer MVP (Days 6-9)

#### Task 2.1: Dependency Graph Builder
**Files**: `src/analyzer/graph.ts`

**Steps**:
1. Walk node_modules recursively
2. Parse each package.json for name, version, dependencies
3. Build adjacency list representation
4. Handle nested node_modules (npm) and flat (pnpm) structures
5. Track which packages are direct vs transitive

**Data Structure**:
```typescript
interface DependencyNode {
  name: string;
  version: string;
  path: string;
  size: number;
  dependencies: string[]; // package@version
  isDirect: boolean;
}
```

**Acceptance**: Graph correctly represents node_modules structure

---

#### Task 2.2: Duplicate Detection
**Files**: `src/analyzer/duplicates.ts`

**Steps**:
1. Group packages by name
2. Identify packages with multiple versions
3. Calculate wasted space (size of duplicates)
4. Rank by impact (size * count)
5. Suggest resolution (highest version, or specific)

**Output**:
```typescript
interface DuplicateReport {
  package: string;
  versions: { version: string; count: number; paths: string[] }[];
  wastedBytes: number;
}
```

**Acceptance**: Detects lodash@4.17.20 and lodash@4.17.21 as duplicates

---

#### Task 2.3: Depth Analysis
**Files**: `src/analyzer/depth.ts`

**Steps**:
1. BFS from root dependencies
2. Calculate max depth
3. Find longest dependency chain
4. Identify packages at each depth level

**Acceptance**: Reports max depth and critical path

---

#### Task 2.4: Deprecation Detection
**Files**: `src/analyzer/deprecation.ts`

**Steps**:
1. Default: offline deterministic mode emits `deprecated: unknown`
2. Opt-in online mode: check registry for deprecation status (`--registry-check`)
3. Cache results with timestamp and source attribution

**Acceptance**: Lists deprecated packages with deprecation message

---

#### Task 2.5: Analyze Command
**Files**: `src/cli/commands/analyze.ts`

**Steps**:
1. Run filesystem scan
2. Build dependency graph
3. Detect duplicates
4. Calculate depth
5. Check deprecations
6. Output comprehensive report

**Output Format**:
```json
{
  "summary": {
    "totalPackages": 523,
    "directDependencies": 24,
    "logicalSize": 156000000,
    "physicalSize": 98000000,
    "maxDepth": 12
  },
  "duplicates": [...],
  "deprecated": [...],
  "largestPackages": [...]
}
```

**Acceptance**: JSON output matches documented schema

---

#### Task 2.6: Web UI - Server
**Files**: `src/ui/server.ts`

**Steps**:
1. Create minimal HTTP server (no Express, use http module)
2. Serve static files from bundled UI
3. Provide `/api/analysis` endpoint with cached data
4. Find available port (default 3000)
5. Open browser automatically (with `--no-open` flag to disable)

**Acceptance**: `better analyze --serve` opens browser with report

---

#### Task 2.7: Web UI - Frontend
**Files**: `ui/src/*`

**Steps**:
1. Set up Vite + React (or vanilla) project
2. Implement treemap visualization (d3 or lightweight alternative)
3. Create package table with sorting/filtering
4. Add drilldown for package details
5. Bundle as static assets into main package

**Acceptance**: UI displays all analysis data interactively

---

### Phase 3: Doctor + Health Score (Days 10-12)

#### Task 3.1: Health Check Framework
**Files**: `src/doctor/engine.ts`, `src/doctor/score.ts`

**Steps**:
1. Define check interface:
   ```typescript
   interface HealthCheck {
     id: string;
     name: string;
     severity: 'error' | 'warning' | 'info';
     weight: number; // score deduction
     run(context: AnalysisContext): Promise<Finding[]>;
   }
   ```
2. Implement check runner with parallel execution
3. Calculate score: `100 - sum(finding.weight)`
4. Floor at 0, cap at 100

**Acceptance**: Framework runs all checks and computes score

---

#### Task 3.2: Health Checks Implementation
**Files**: `src/doctor/checks/*.ts`

**Checks**:
| Check | Weight | Trigger |
|-------|--------|---------|
| Deprecated packages | 5 each, max 25 | Any deprecated package |
| Duplicate packages | 2 each, max 20 | Same package, different versions |
| Excessive depth | 10 | Max depth > 10 |
| Large node_modules | 15 | Size > 500MB |
| Security advisories | 10 each, max 30 | Known vulnerabilities |
| Outdated lockfile | 5 | Lockfile older than package.json |

**Acceptance**: Each check produces actionable findings

---

#### Task 3.3: Doctor Command
**Files**: `src/cli/commands/doctor.ts`

**Steps**:
1. Run analysis (reuse analyzer)
2. Execute all health checks
3. Calculate and display score
4. Group findings by severity
5. Exit with code based on threshold

**Output**:
```
Health Score: 73/100

ERRORS (2):
  - [deprecated] 'request' is deprecated: use 'node-fetch' instead
  - [security] lodash@4.17.20 has known vulnerabilities

WARNINGS (5):
  - [duplicate] 'debug' has 3 versions installed
  ...

Run 'better doctor --fix' to attempt automatic fixes.
```

**Acceptance**: Score reflects actual project health

---

#### Task 3.4: Auto-fix Implementation
**Files**: `src/doctor/fixes/*.ts`

**Steps**:
1. Defer auto-fix in MVP; output exact suggested commands instead
2. If introduced, require explicit opt-in and produce a preview diff
3. Never run fixes that may change resolution semantics without an explicit override

**Acceptance**: `better doctor --fix` improves score


---

### Phase 4: Cache Commands (Days 13-14)

#### Task 4.1: Cache Stats Command
**Files**: `src/cli/commands/cache.ts`

**Steps**:
1. Implement `better cache stats`:
   - Total cache size
   - Number of cached packages
   - Oldest/newest entry
   - Cache hit ratio (if tracked)
2. Output as JSON with `--json` flag

**Acceptance**: Shows accurate cache statistics

---

#### Task 4.2: Cache GC Command
**Files**: `src/cache/gc.ts`

**Steps**:
1. Implement `better cache gc`:
   - Remove entries older than N days (default 30)
   - Remove entries not accessed in N days
   - `--dry-run` to preview
2. Report space reclaimed

**Acceptance**: GC removes stale entries, reclaims space

---

#### Task 4.3: Cache Explain Command
**Files**: `src/cli/commands/cache.ts`

**Steps**:
1. Implement `better cache explain <package>`:
   - Show if package is cached
   - Show cache key derivation
   - Show last access time
2. Help debug cache misses

**Acceptance**: Explains cache state for any package

---

## Risk Identification

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Yarn Berry detection edge cases | Medium | Medium | Test with multiple Yarn configs |
| Windows path handling | Medium | High | Use path.sep, normalize early |
| Large node_modules performance | Low | High | Streaming scan, abort early if too large |
| Package manager version incompatibility | Medium | Medium | Test with multiple versions in CI |
| Hardlink detection on network drives | Low | Low | Fallback to logical size only |
| npm registry rate limiting | Medium | Low | Cache deprecation checks aggressively |

---

## Testing Strategy

### Unit Tests
- Config loading and merging
- Argument parsing edge cases
- Size calculations with mocked fs
- Duplicate detection algorithms
- Score calculation

### Integration Tests
- Package manager detection with fixture lockfiles
- Full analyze flow on fixture node_modules
- Doctor checks with known problematic projects
- Cache operations

### E2E Tests
- `better install` on real project
- `better analyze --json` output validation
- `better doctor` score consistency

### Fixtures
```
tests/fixtures/
├── npm-project/          # npm lockfile
├── pnpm-project/         # pnpm lockfile
├── yarn-classic-project/ # yarn.lock (v1)
├── yarn-berry-project/   # yarn.lock (v3+) + .yarnrc.yml
├── with-duplicates/      # Known duplicate packages
└── with-deprecated/      # Known deprecated packages
```

---

## Verification Steps

### Phase 0 Verification
```bash
# Build succeeds
pnpm build

# CLI starts
./dist/cli.js --version
./dist/cli.js --help

# Config loads
echo '{"logLevel":"debug"}' > .betterrc
./dist/cli.js analyze --dry-run

# Detection works
cd tests/fixtures/npm-project && ../../../dist/cli.js analyze --dry-run
cd tests/fixtures/pnpm-project && ../../../dist/cli.js analyze --dry-run
```

### Phase 1 Verification
```bash
# Install works
better install
better install --dry-run
better install --json

# Metrics captured
better install --json | jq '.duration'
```

### Phase 2 Verification
```bash
# Analyze works
better analyze
better analyze --json | jq '.summary'

# Duplicates detected
better analyze --json | jq '.duplicates'

# UI serves
better analyze --serve
curl http://localhost:3000/api/analysis
```

### Phase 3 Verification
```bash
# Doctor works
better doctor
better doctor --json | jq '.score'

# Threshold exit code
better doctor --threshold 90 || echo "Below threshold"

# Fix applies
better doctor --fix --dry-run
```

---

## Commit Strategy

### Phase 0 Commits
1. `chore: initialize project with TypeScript, tsup, vitest`
2. `feat: implement CLI parser and command routing`
3. `feat: add configuration system with schema validation`
4. `feat: implement NDJSON logger`
5. `feat: add package manager detection and adapters`
6. `feat: create cache directory structure`
7. `feat: implement filesystem scanner with hardlink detection`

### Phase 1 Commits
1. `feat: implement better install command`
2. `feat: add install metrics collection`
3. `feat: add dry-run mode for install`

### Phase 2 Commits
1. `feat: build dependency graph from node_modules`
2. `feat: implement duplicate package detection`
3. `feat: add depth analysis`
4. `feat: detect deprecated packages`
5. `feat: implement analyze command with JSON output`
6. `feat: add web UI server`
7. `feat: create React-based analysis UI`

### Phase 3 Commits
1. `feat: implement health check framework`
2. `feat: add health checks (deprecated, duplicates, depth, size)`
3. `feat: implement doctor command with scoring`
4. `feat: add auto-fix capability`

### Phase 4 Commits
1. `feat: add cache stats command`
2. `feat: implement cache garbage collection`
3. `feat: add cache explain command`

---

## Success Criteria

### MVP Complete When
- [ ] All Phase 0-3 acceptance criteria pass
- [ ] Test coverage > 80%
- [ ] CI pipeline green
- [ ] README with usage examples
- [ ] `better install`, `analyze`, `doctor` work on real projects
- [ ] JSON output matches schema for all commands
- [ ] Cross-platform: tested on macOS, Linux, Windows

### Quality Gates
- TypeScript strict mode, no `any`
- ESLint + Prettier clean
- No npm audit vulnerabilities in dependencies
- Bundle size < 5MB (excluding UI)
- Startup time < 100ms

---

## Dependencies (Minimal)

### Runtime (Consider Zero)
- None initially - prefer Node built-ins
- Consider: `better-sqlite3` for metadata DB (optional)

### Dev Dependencies
- `typescript` - Type safety
- `tsup` - Build and bundle
- `vitest` - Testing
- `eslint` + `prettier` - Code quality
- `@types/node` - Node.js types

### UI Dependencies (Separate Package)
- `vite` - Build
- `react` - UI (or vanilla if simpler)
- `d3` or `@visx/*` - Treemap visualization

---

## Timeline Summary

| Phase | Days | Deliverables |
|-------|------|--------------|
| Phase 0 | 1-3 | CLI shell, config, logging, adapters, FS engine |
| Phase 1 | 4-5 | `better install` with metrics |
| Phase 2 | 6-9 | `better analyze` with graph, duplicates, UI |
| Phase 3 | 10-12 | `better doctor` with health score |
| Phase 4 | 13-14 | Cache commands (stats, gc, explain) |

**Total: ~14 days for MVP**

---

PLAN_READY: .omc/plans/better-npm.md
