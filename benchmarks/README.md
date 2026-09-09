# Verified install benchmarks

`node benchmarks/runner.mjs --rounds 3` compares npm and the checked-out better
CLI with the same npm lockfile, scripts disabled, and fresh per-round caches.
The runner currently supports only npm and better because other managers require
different lockfiles. Failed or mismatched installations have null timing metrics
and produce a nonzero exit status. Lock generation is untimed with a separate cache.

`better benchmark` compares a package manager with its better wrapper (or the
native engine with npm). All contenders disable lifecycle scripts. Each invocation
uses a unique cache namespace, restores the original manifest/lock inputs before
and after each install, and passes the cache root explicitly to better. Warm-cache
runs prime each contender separately; `reuse_noop` also retains node_modules.
`--frozen --scenario reuse_noop` is rejected before any install or cache writes:
`npm ci` recreates node_modules, so it cannot represent a retained-tree no-op.
Use `warm_hit` for frozen comparisons.
A warm better cache includes materialization reuse, while a raw manager retains
its own native caches. These are product-level scenarios, not equal-work engine
microbenchmarks. OS filesystem caches and network conditions are uncontrolled.

Before timing is summarized, required direct dependencies and non-optional npm
lock entries must exist, locked npm versions must match, and the installed package
name/version inventory must agree across contenders and rounds. This does not
validate package file contents, module resolution, executable links, or runtime
behavior. pnpm/yarn output checks have no npm-lock completeness guarantee.

CI builds the native engine and uploads a verified report. It fails on install or
output-check errors. Timings are informational: a single hosted-runner comparison
is not evidence of a performance regression or a publishable speed claim. Legacy
comparative reports predate these controls and should not be used as current
performance evidence.

## Concurrent worktree evidence

`worktrees.py` measures the native installer in independent temporary projects
sharing one cache. It requires Python 3.9+ and macOS or Linux, uses only the Python
standard library, and serves synthetic tarballs over loopback. It does not contact
a package registry or modify existing projects. No npm baseline or speedup ratio
is produced. Build the binary from the source commit being evaluated first:

```sh
cargo build --locked --manifest-path crates/Cargo.toml -p better-core --release
python3 benchmarks/test_worktrees.py
python3 benchmarks/worktrees.py --binary crates/target/release/better-core \
  --workers 1,4,20 --rounds 3 --packages 8 --payload-kib 64 \
  --jobs 4 --output /tmp/worktree-evidence.json
```

For a modest CI smoke, use `--workers 1 --rounds 1 --packages 2 --payload-kib 1`.
The default is one worker and one round. `--delay-ms` adds controlled server
latency, which must not be presented as real registry performance. `--timeout`
limits each native process (default 120 seconds). Worker count is the number of
simultaneously launched installations, not an assertion about native thread count.
`--jobs` is passed through to the binary; actual HTTP overlap is measured separately.

Each worker-count/round starts with a fresh shared cache and isolated HOME:

1. `cold`: empty cache and absent node_modules.
2. `warm`: delete node_modules, retain cache and installer metadata, reinstall.
3. `change`: update one exact direct dependency in manifest and lockfile.
4. `recovery`: remove one installed package and require reconstruction.
5. `mutation_isolation`: overwrite an installed file in place, verify other trees,
   then install a fresh tree from the same cache and verify its complete contents.

Every normal scenario requires successful exit, the expected package inventory,
and byte-identical manifest, entrypoint and payload files. A failed scenario is
recorded and subsequent scenarios for that cohort stop; the command exits nonzero
if any cohort fails. Failed timings are diagnostic samples, never speed evidence.
Scripts are disabled. Fixtures are flat packages, so these results do not establish
application builds, nested resolution, executable links, lifecycle behavior,
interrupted cache publication, Cargo builds, or security vulnerability policy.
The mutation check catches shared writable hardlinks; it is not a security sandbox.

Reports include the executable SHA-256, OS/platform and all configuration. Retain
the source commit alongside the report: the binary hash identifies bytes, not the
source revision or whether a build was release/debug. Raw per-child measurements
are retained instead of summarizing a single run into a performance claim:

- Cohort wall time covers install processes, excluding fixture setup and validation.
- CPU is the sum of child user/system usage from `wait4`; Python coordination and
  the synthetic HTTP server are excluded.
- RSS is each child's reported high-water mark and the largest of those values.
  It is **not peak aggregate RAM**; summing peaks would not establish that either.
- HTTP counts and response-body bytes cover synthetic tarball GETs, not wire bytes.
- Disk reports logical file sizes and inode-deduplicated `st_blocks * 512` before
  and after each install phase. This does **not** deduplicate APFS/reflink shared
  extents, measure disk writes, or prove unique physical storage savings.
- OS page cache is uncontrolled. Disk and RSS accounting are platform dependent.
  Swap, disk I/O bytes and aggregate RAM are unavailable, not implicitly zero.

Cold/warm/change/recovery are sequential within a cohort. Rounds are independent;
worker-count order is explicit and not randomized. Compare repeated samples on the
same machine and filesystem before attributing differences to a code change.

### Paired native worktree diagnostic

Run `paired_worktrees.py` with independently built baseline and candidate binaries:

```sh
python3 benchmarks/paired_worktrees.py \
  --baseline /absolute/path/to/baseline-better-core \
  --candidate /absolute/path/to/candidate-better-core \
  --workers 1,4,20 --rounds 3 --mode all \
  --output /absolute/path/to/raw-results.json
```

The paired `diagnostic` mode disables the firewall only in temporary synthetic
projects. It measures installation mechanics and must not be presented as a
production default-policy speedup. The separate `candidate-default` mode keeps
default policy enabled and points `NPM_CONFIG_REGISTRY` to an ephemeral localhost
registry. It requires a candidate that honors this setting for security metadata.
The historical baseline hardcodes the public security metadata endpoint, so the
harness deliberately does not run that baseline in default-policy mode.

Each cohort has isolated HOME/cache state and deterministic payloads unique to
package name and version. Cold starts with an empty installer cache; warm removes
`node_modules`; noop retains the installed tree and lockfiles. OS page caches are
not flushed. All installed file contents are checked after each scenario, followed
by an in-place mutation probe against other worktrees and a fresh cache consumer.
Metadata and tarball requests are counted by route; unexpected routes fail the
run. Local counters do not enforce network isolation, so OS-level outbound
restrictions are needed to prove no external requests were made.

Raw JSON records binary hashes, per-child blocking-wait timings, CPU, largest
child RSS, route counts, disk observations and validation failures. Largest child
RSS is not aggregate peak RAM, and inode-deduplicated `stat` blocks cannot measure
unique physical CoW extents. Timing includes fresh native CLI startup; resident
session latency must be measured separately. No synthetic scripts run.

Do not run performance cohorts concurrently with builds or other benchmarks.
Compare matching scenarios and round pairs; do not combine candidate-default
results with diagnostic baseline results to calculate a speedup.

Harness validation (no native benchmark):

```sh
python3 -m unittest discover -s benchmarks -p 'test*worktrees.py'
```

### Resident ready-time comparison

```sh
node benchmarks/resident_installs.mjs \
  --binary /absolute/path/to/candidate-better-core \
  --workers 1,4 --rounds 3 \
  --output /absolute/path/to/resident-results.json
```

Build the matching release addon first. This script calls the real
`runResidentInstall` API without subprocess fallback, comparing full ready time
against fresh native CLI processes. First resident use includes lazy addon and
pool startup and is flagged separately. Both paths keep default policy enabled
and use a local registry. Warm removes the destination; noop retains it. A new
artifact cache does not reset process-global resident plans or metadata, so the
first scenario is named `cold-artifact`, not universally cold. Twenty-project
cohorts are supported with eight outstanding requests maximum. Queue wait and
ready fields are retained alongside external wall timers. Results validate every
installed file and report loaded addon hashes. This is not a queue admission,
prepared-tree activation, aggregate memory, or kernel filesystem benchmark.
