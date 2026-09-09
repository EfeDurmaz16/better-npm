# Shared install performance campaign

This change combines the worktree performance campaign into one review. It targets
repeated installs with shared package content and long-lived agent processes.
It does not establish a universal speedup over npm, a sub-millisecond complete
install, or a physical storage/RAM reduction multiplier.

## Review map

| Area | Implemented behavior | Main sources |
| --- | --- | --- |
| Resident requests | CLI, NAPI and MCP share canonical install orchestration; up to four resident coordinators with eight waiting slots | `install.rs`, `coordinator.rs`, `better-napi/src/lib.rs` |
| Worker reuse | Process-wide materialization pool; NAPI deferred completion does not occupy Node filesystem workers | `analyze.rs`, `lib.rs`, `coordinator.rs` |
| File publication | Private staging arenas, bounded chunks, fresh hoist tree preparation followed by same-filesystem activation | `lib.rs`, `install.rs` |
| Unchanged trees | Compare complete file contents and identity/mode conditions before reuse; repair changed files and links | `lib.rs`, `binlinks.rs`, `cas.rs` |
| Parsed plans | Bounded cache keyed by actual lockfile bytes; canonical install shares the parsed plan | `fetch.rs` |
| Dependency graph | Indexed dependency lookup, reverse-edge platform propagation, distinct strict-layout resolution contexts and aliases | `strict.rs`, `platform_selection.rs` |
| Artifact pipeline | Shared reader leases, producer rechecks, bounded resource slots, deadline-based retries, bounded offline preparation | `artifact_cache.rs`, `fetch_scheduler.rs` |
| Remote evidence | Shared client/pool, exact request identities, authenticated-source isolation, expiring validated evidence | `audit/evidence.rs`, `audit/cache.rs`, `osvEvidence.js` |
| JS bookkeeping | Project and PM-sample shards, serialized state updates, bounded manifest reads, reusable directory observations | `cache.js`, `pmCacheSnapshots.js`, `nodeModules.js` |
| Delivery and measurement | Matching native binary/addon release packaging, package smoke tests, paired and resident benchmark harnesses | release workflow, `postinstall.js`, `benchmarks/` |

Paths in the table are under `crates/better-core/src` unless a binding, JS file,
workflow, or benchmark is named. See [resident behavior](resident-installs.md) and
[bookkeeping migration](cache-bookkeeping.md) for API and operational details.

## Evidence

Final measurements and reproducible per-round samples are recorded below. The baseline is commit `20455f03e4db31c9ced08f11c01cbdb4a4598b1f`.

Measured on macOS 26.6.2 / arm64, with three rounds at 1, 4 and 20 worktrees.
The fixture has eight packages, three files per package and a unique 64 KiB payload
per package/version. Timings are cohort medians in milliseconds.

### Paired native CLI diagnostic

Both versions use temporary fixtures with firewall disabled for this diagnostic.
The baseline hardcodes the public metadata registry, so an equivalent local
default-policy pair cannot be constructed. These are engine diagnostic results,
not default-policy production speedups. Cold means empty installer cache, warm
means a new `node_modules` with a populated cache, and noop retains the tree.

| Worktrees | Scenario | Baseline ms | Candidate ms | Baseline CPU s | Candidate CPU s |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | cold | 117.45 | 107.05 | 0.2050 | 0.0576 |
| 1 | warm | 11.59 | 12.02 | 0.0197 | 0.0144 |
| 1 | noop | 12.62 | 10.57 | 0.0230 | 0.0132 |
| 4 | cold | 149.00 | 118.06 | 0.5926 | 0.1363 |
| 4 | warm | 18.06 | 18.74 | 0.1221 | 0.0934 |
| 4 | noop | 19.06 | 15.36 | 0.1341 | 0.0777 |
| 20 | cold | 194.61 | 147.10 | 1.0785 | 0.8312 |
| 20 | warm | 63.77 | 66.63 | 0.6442 | 0.6772 |
| 20 | noop | 68.19 | 51.08 | 0.7261 | 0.3968 |

Cold and noop improve in this fixture. Warm fresh-tree timings regress by roughly
4% at widths 1, 4 and 20; this campaign does not eliminate filesystem work.

### Resident NAPI versus the same candidate native CLI

Default policy uses a local metadata fixture with scripts disabled. Both modes
await the complete canonical report. Resident process state survives cohorts;
cold-artifact resets artifact/project storage, not all process-global caches.
Native process startup is included for the CLI; Node supervisor startup is
excluded for both. Module import is recorded separately. At most eight requests
are outstanding, including the 20-worktree cohort.

| Worktrees | Scenario | Fresh native CLI ms | Resident ms |
| --- | --- | ---: | ---: |
| 1 | cold-artifact | 103.22 | 90.22 |
| 1 | warm | 10.72 | 5.93 |
| 1 | noop | 8.45 | 3.93 |
| 4 | cold-artifact | 118.85 | 115.02 |
| 4 | warm | 17.97 | 13.46 |
| 4 | noop | 14.12 | 9.36 |
| 20 | cold-artifact | 169.86 | 167.78 |
| 20 | warm | 64.67 | 61.36 |
| 20 | noop | 51.42 | 42.23 |

The earlier serial coordinator lost at width 20: warm was 96.07 ms resident
versus 61.15 ms fresh CLI, and noop was 57.65 versus 49.78 ms. Those samples are
retained alongside the final four-coordinator results. This distinguishes the
effect of residency from the effect of serializing independent projects.

### Requests, storage and measurement limits

The separate candidate-default paired cohorts performed exactly eight metadata
requests and eight tarball requests on cold installs at every width and round;
warm/noop performed zero of either. All package bytes and mutation-isolation
checks passed. This demonstrates duplicate-work suppression in this fixture,
not a clean audit of arbitrary dependencies.

| Diagnostic cold cohort | Baseline | Candidate |
| --- | ---: | ---: |
| 1 worktrees, logical MiB after install | 2.02 | 1.51 |
| 1 worktrees, largest child RSS MiB | 13.52 | 12.56 |
| 20 worktrees, logical MiB after install | 11.67 | 11.16 |
| 20 worktrees, largest child RSS MiB | 13.38 | 12.56 |

Logical byte totals count named files, including shared-cache contents; they
are not unique physical APFS allocation. Inode-deduplicated stat blocks also do
not deduplicate copy-on-write extents. RSS is the largest child, not aggregate
peak RAM across children or a measurement of the resident process. CPU is summed
child user/system time. OS page caches were not dropped. Validation and disk walks
are outside timed intervals. Three rounds do not establish p99 behavior.

[Per-round samples and artifact hashes](../benchmarks/results/shared-install-2026-09-10.json) include the initial slower candidate and serial coordinator variants.
[Reproduction commands](../benchmarks/README.md) describe both harnesses.
The final binary SHA-256 is `62ea854aece9242677d60b9bb4bf3f89753cf31e115e00c608d85297473174ed`.

## Boundaries and remaining work

- The resident coordinator is process-local. Independent agent processes still
  have independent coordinators; no machine-wide daemon or IPC service is added.
  Fetch pools remain transient per install, capped to eight preparation/network
  and four extraction lanes per online resident request. The shared materializer
  and evidence executor have their own process-wide bounds.
- A safe single-inflate extraction path is deferred. The installed tar parser
  does not provide the required metadata-allocation bound; bounded preflight and
  extraction remain separate passes.
- Cached remote evidence is not a permanent security verdict. Current local
  content, policy and waivers are reevaluated. A package gaining a new advisory
  needs refreshed evidence; TTLs are not immediate revocation. No persistent
  local content-verdict shortcut, ETag refresh, or JS/native cross-process
  producer-lock unification is claimed.
- Fresh hoist trees are prepared privately. Existing trees and strict layouts
  reconcile in place; lifecycle scripts run after activation. There is no full
  rollback or power-loss durability guarantee and no running-request cancellation.
- Project references are telemetry, not authority for destructive cache GC.
  No new reference-aware garbage collection is introduced. Non-project aggregate
  state still uses full JSON updates; native size scans still need a separate
  package-identity inventory.
- Release packaging is tested locally for the built macOS binary/addon pair.
  Cross-target release compilation and live release publication are not verified
  by local tests. Musl release artifacts retain the core-only fallback.

## Validation

- Release workspace build passed on macOS arm64.
- All 1,560 Rust tests passed across 17 compiled test executables, with serial
  execution for existing environment-mutating tests.
- 119 targeted JavaScript tests passed without skips, including packaged native
  pairing, resident filesystem responsiveness, cache contention, OSV evidence,
  NAPI integration, and postinstall archives. Tests used a credential-free
  allowlisted environment and local fixtures.
- Eight benchmark harness unit tests passed; all paired and resident benchmark
  validation checks passed.
- Lint, build/syntax, typecheck script and diff whitespace checks passed. The
  repository's typecheck script is a JavaScript syntax check, not TypeScript analysis.
- The full JavaScript suite is not locally green evidence. Its sandboxed run hit
  network restrictions; an unrestricted inherited-environment rerun was rejected
  by automatic approval review because tests could transmit environment credentials.
  The isolated targeted run above was approved and passed. The full matrix is
  delegated to the PR CI, not represented as passed here.
