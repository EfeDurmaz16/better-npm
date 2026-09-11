# Resident installs

The native CLI, the NAPI `installResident` binding, and the MCP `install` tool share `install::run_install`. The resident paths execute native installation directly; they do not launch another Better CLI process.

## Request and completion

```js
import { runResidentInstall } from "better/src/lib/core.js";

const report = await runResidentInstall("/absolute/project", {
  cacheRoot: "/absolute/shared-cache",
  scripts: false,
  offline: true
});
```

This internal module path illustrates the binding; it is not a new package export contract. `runResidentInstall` returns `null` when the optional addon lacks support. `runBetterCoreInstall` automatically substitutes only a release-installed `bin/better-core` and `bin/better-core.node` pair. Development binaries keep their selected executable because a separately built addon may be stale. An explicit `BETTER_CORE_PATH` or `resident: false` preserves the subprocess path. It never retries through the CLI after resident submission, because an error may follow filesystem changes.

Direct addon callers pass a JSON options object to `installResident` and receive a Promise containing the canonical JSON report. Paths must be absolute. Unknown fields, invalid resource bounds, and unsupported sandbox/provenance guarantees are rejected before queue admission.

The process-local coordinator has up to four persistent install orchestration threads (bounded by available CPUs) and eight waiting slots. Independent projects may execute concurrently; the project writer lease still rejects competing writers for the same project. Admission fails promptly when full. Package and file operations share the bounded materialization executor. Resident fetch requests are upper bounds: each running install uses at most eight network/preparation workers and four extraction workers, preserving smaller requested limits. With four orchestration workers this bounds transient fetch workers to 48 per resident process. Offline hashing and repair use the smaller of the effective network and extraction bounds (at most four preparation lanes), plus one idle handoff consumer; returned offline fetch metrics preserve those effective bounds. These fetch pools remain per-install; they are not a new shared pool. Validation rejects requests outside the original valid range before applying caps, and fetch metrics report the effective limits. Direct CLI installs retain their existing bounds. Independent host processes have independent resident coordinators; this is not a machine-wide daemon. MCP's current request loop waits for each tool result, while NAPI allows concurrent callers to submit bounded requests.

The Promise/tool response reports **ready**, after bins, lifecycle handling, policy reporting, and receipt processing complete. `resident.coordinatorWorkers` reports the orchestration bound. `resident.queueWaitMicros` measures time before execution and `resident.readyMicros` includes that wait and execution. Existing millisecond timings remain available alongside additive microsecond phases. Neither queue acceptance nor fast prepared-tree activation is a complete install benchmark.

NAPI completion uses a deferred Promise dispatched from the coordinator through a threadsafe function. Pending installs do not occupy libuv worker tasks, and no per-request waiter thread or polling loop is created. Queue admission failures also complete the deferred with a failed canonical report.

Cancellation is not currently exposed. A disconnected caller must not assume that an accepted request stopped executing.

## Preparation and writer coordination

Fresh hoist installs prepare package files and bin links inside a private sibling container on the same filesystem, then rename the inner tree to `node_modules`. Failed preparation removes the temporary directory without publishing a partial tree. The outer container remains private; the published tree uses ordinary directory creation permissions under the current process umask. Existing trees and strict layouts keep their reconciliation paths; they do not receive a full-tree transaction.

Lifecycle scripts run after activation because they may depend on final project paths. Their output is routed to stderr to preserve CLI and MCP JSON stdout. Script-side mutations are not rolled back. The install report retains the canonical script and firewall status semantics; residency does not introduce new security guarantees.

A stable `.better/install.lock` OS advisory lock serializes cooperating writers for the same project across processes. Contention returns a busy error rather than waiting indefinitely, including nested installs from lifecycle scripts. Closing the handle or process releases the lock. The lock file must not be unlinked while a writer may hold it.

Parsed plans are shared only after comparing the current lockfile bytes through the bounded plan cache. Artifact lifecycle leases keep source generations stable during materialization. A mutable destination marker is never treated as proof that its files are unchanged.
