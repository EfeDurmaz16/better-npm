# Cache bookkeeping and tree observations

Install receipts use UUID names and complete-file atomic publication. The shared
index uses schema version 3. Project records live in `projects/<sha256-key>.json`;
PM measurement samples live in `pm-cache-snapshots/<sha256-path>.json`. Keys remain
inside each record and are checked on read.

An install loads its own project record. Cache and analysis mutations do not load
project records. Readers requesting the whole index merge project shards with any
remaining schema version 2 project entries. Legacy entries migrate when selected
for an update; entries outside that update remain in the legacy aggregate until
they migrate. Only changed project shards are rewritten. PM sample migration is
read-only and preserves the legacy snapshot file.

Every shared-state writer uses `updateState`, which acquires ownership before
reading current counters and references. A current native binary supplies an OS
advisory lease through `better-core state-lock`. The helper holds the lock while
its stdin is open; an interrupted parent closes the pipe and releases the lease.
The stable `state.json.lock` file must not be removed while writers may run.

When the native helper is unavailable, a bounded directory-lock fallback supports
JS-only installations. An interrupted fallback writer requires explicit operator
recovery: stop all writers, confirm the owner in `state.json.lock/owner.json` is
no longer active, then remove the lock directory. Elapsed time never authorizes
lock stealing. Once a cache uses a native lock file, an old helper cannot use the
fallback protocol for that cache. Use a current binary. Running older Better
versions that do not understand schema version 3 against the same cache is not a
supported writer configuration.

Records are written to unique temporary files, synced, and renamed into place.
Parent directories are not synced, so this is not a power-loss durability claim.
Project records and aggregate counters are separate publications, not an atomic
multi-record snapshot. After interruption, readers may observe an updated project
record and older aggregate counters. A valid project record remains recoverable;
corrupt records fail closed rather than being overwritten as an empty index.
These telemetry records do not establish an artifact's verification or authorize
additional cache deletion. No new garbage collection is enabled by this change.

Package-count observations retain distinct `name@version` semantics, including
nested and scoped packages. Manifest reads use at most eight workers. When size
measurement falls back to the JS walker, that walk supplies relevant directory
entries to the package counter within the same observation. Pre-install and
post-install observations remain separate. Native size scans still require a
separate identity inventory; their raw package count is not substituted for the
existing distinct-identity contract.

Remaining costs: non-project aggregate indexes still require full JSON reads and
writes, full-index consumers still read all project records, native state locking
starts a helper process, and native size scans do not yet supply a shared identity
inventory. No speedup or physical storage reduction follows solely from this
bookkeeping format change.
