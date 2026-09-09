# Native fetch resource controls

The experimental native engine exposes independent preparation and extraction worker budgets. The preparation stage checks the cache and obtains verified compressed artifacts. The extraction stage preflights and unpacks them. Fixed worker pools bound both stages; the ready-artifact queue holds at most `extract_jobs` items, and producers can hold at most `network_jobs` additional pending items. This bounds active work, not total cache disk usage.

```sh
better install --engine better --experimental --jobs 8 --extract-jobs 2
```

| CLI flag | JS bridge / NAPI option | Default |
| --- | --- | --- |
| `--jobs` | `jobs` | Available parallelism, clamped to 1..64. `--fs-concurrency` remains a separate materialization setting. |
| `--extract-jobs` | `extractJobs` | Effective `jobs` value |
| `--max-tarball-bytes` | `maxTarballBytes` | 536870912 bytes (512 MiB) |
| `--max-expanded-bytes` | `maxExpandedBytes` | 2147483648 bytes (2 GiB) |
| `--max-archive-entries` | `maxArchiveEntries` | 100000 raw archive entries |
| `--max-archive-metadata-bytes` | `maxArchiveMetadataBytes` | 1048576 bytes (1 MiB) |

JS install requires `--engine better` for these flags. JS bridges and NAPI require worker counts in 1..256 and positive safe integer artifact limits. Direct native CLI accepts positive integers and caps worker counts at 256, preserving its existing `--jobs` behavior. Invalid values fail before fetch work; JS install validates them before creating project/cache directories. These options control fetch operations, not package lifecycle-script concurrency.

Artifact budgets apply independently to each artifact when its download or extraction executes. A complete cached artifact skips extraction, so lowering extraction limits does not re-run or retroactively reject prior extraction work. Compressed bytes bound the downloaded archive. Expanded bytes bound the decompressed archive stream, including archive overhead, rather than only the final package payload. Raw entry accounting includes extension headers. Metadata limits constrain archive extension metadata before it can cause large allocations. Raising limits increases the resources an artifact may consume.

Streaming uses a 64 KiB application copy buffer. This is not a process RSS bound: HTTP, compression, archive handling, queues, runtime overhead and other install phases also use memory. Likewise worker limits are per fetch invocation, not a machine-wide limit across unrelated processes.

Extraction deliberately decompresses twice: a bounded preflight validates the archive before the extraction pass writes its entries. This trades decompression CPU for predictable validation before writes. Sparse archives and PAX entries whose declared size differs from the underlying header are unsupported and fail explicitly.

Native reports expose `stats.fetchMetrics`; NAPI returns `metrics`. Fields record configured worker counts, queue capacity, observed peak workers, and summed preparation/extraction/backpressure microseconds. Stage duration totals sum elapsed time across concurrent work. They are neither end-to-end wall time nor CPU time and must not be added together to claim install latency. Measure wall time, CPU time and peak RSS independently when comparing worker settings. More workers can increase memory pressure and disk contention; choose settings from representative measurements.

## Runtime reporting

`install.backend` records the operation actually performed: `native-binary`, `none` for a local no-op reuse, `cache-materialize` for a successful global-cache restore, or `package-manager`. When the native binary performs installation, `engineRuntime.selected` is `rust`, `engineRuntime.backend` is `native-binary`, and `engineRuntime.requested` retains the requested core mode. Explicit `js` or `napi` requests report the binary requirement as the fallback reason. Global-cache restore details remain separately available under `materialize.runtime`; runtime availability alone does not establish that an installer executed.
