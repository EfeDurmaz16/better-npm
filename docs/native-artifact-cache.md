# Native artifact cache

Tarballs are verified against the lockfile digest before publication or reuse.
Extraction runs in a private sibling staging directory. Only a complete directory
with the current completion marker is renamed into the canonical artifact path.
A verified retained tarball repairs a missing extraction without a network request.
Incomplete legacy directories are quarantined, not recursively deleted.

Native destructive artifact GC is temporarily unavailable: it previously deleted
individual files from potentially live artifacts. `better-core cache gc --dry-run` is only an
age estimate, not a promise that these bytes can safely be reclaimed. Shared reader
leases are required before destructive collection can be restored. Staging from an
abruptly terminated process and quarantined artifacts may consume disk until an
explicit safe maintenance mechanism is implemented.

This cache is not an isolation boundary against another process that can directly
write its root. Integrity establishes content identity, not package safety.

Concurrent legacy repair requires the per-content producer lock in campaign slot 4.
Transactional publication alone is not a complete shared-cache concurrency contract.
## Concurrent producers

Native producers acquire an OS exclusive file lock per validated content identity
before rechecking the artifact, downloading, and extracting. The lock guard may
move between pipeline workers. Process termination releases ownership through the
OS; there is no stale-time eviction. Lock files remain on disk permanently to avoid
creating multiple lock domains through unlink/recreate races. This requires Rust
1.89 or newer. Network filesystem lock semantics are outside the tested local-disk
contract. Duplicate lockfile entries retain their own installation paths, but only
one producer downloads and extracts their shared artifact.

Run `python3 scripts/tests/native_cache_singleflight.py` after a native debug build
for 1, 4, and 20 simultaneous processes plus interrupted-producer recovery.

## Completeness and offline recovery

Each published extraction includes an inventory of relative paths, entry types,
file sizes, and symlink targets. Cache readiness compares the current tree with
that inventory, so deleted files, extra files, and size changes trigger repair.
The inventory is limited to 100,000 entries and 16 MiB of JSON; exceeding either
limit fails explicitly. Traversal charges encoded path and symlink-target bytes before retaining entries,
including the directory queue's path copies, against a separate 16 MiB accounting
budget. Serialization streams directly through a writer that rejects bytes beyond
the JSON limit. These are metadata accounting limits, not process RSS guarantees.

This is metadata completeness checking, not a full-content integrity proof against
a process able to modify the cache. Retained compressed archive bytes are checked
against the declared digest before use. Equal-size edits to extracted files are
outside the inventory guarantee.

Offline preparation validates all selected identities, acquires the same content
locks as online fetch, verifies retained archives, and rebuilds incomplete trees
without network access. Missing or invalid archives fail before installation
materialization. Legacy trees with valid retained archives migrate locally.

Lazy manifests use the same canonical digest identity as the artifact cache and
point to the extracted `package` directory, not the shared unpacked root.
