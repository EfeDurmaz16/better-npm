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
