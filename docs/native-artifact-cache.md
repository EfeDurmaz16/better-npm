# Native artifact cache

Tarballs are verified against the lockfile digest before publication or reuse.
Extraction runs in a private sibling staging directory. Only a complete directory
with the current completion marker is renamed into the canonical artifact path.
A verified retained tarball repairs a missing extraction without a network request.
Incomplete legacy directories are quarantined, not recursively deleted.

Native destructive artifact GC is temporarily unavailable: it previously deleted
individual files from potentially live artifacts. `cache-gc --dry-run` is only an
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
