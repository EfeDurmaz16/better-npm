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
