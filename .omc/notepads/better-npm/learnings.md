# Configuration System Learnings

## Task 0.3: Configuration System Implementation

### Patterns & Conventions
- **Inline validation**: Implemented Zod-like validation without external dependencies using explicit type checking
- **Configuration precedence**: CLI flags > env vars > config files > defaults (strict order enforced)
- **Type safety**: Full TypeScript types with type guards for runtime validation
- **Singleton pattern**: Global config access via `getConfig()` after initialization with `loadConfig()`
- **Platform-specific paths**: Used OS-specific cache/config directories following platform standards (XDG on Linux, Library on macOS, AppData on Windows)

### Successful Approaches
1. **Validation without dependencies**: Created inline validation functions that return structured error objects instead of throwing
2. **Multiple config sources**: Support for JS/MJS modules, JSON files, .betterrc, and package.json#better field
3. **Environment variable mapping**: BETTER_* prefix for all env vars with proper type coercion
4. **File discovery**: Automatic search through common config file locations
5. **Graceful degradation**: Invalid package.json or missing files don't crash, just skip

### Files Created
- `/Users/efebarandurmaz/better-npm/src/utils/paths.ts` - Platform-specific path resolution
- `/Users/efebarandurmaz/better-npm/src/config/schema.ts` - Config types and validation
- `/Users/efebarandurmaz/better-npm/src/config/defaults.ts` - Default configuration values
- `/Users/efebarandurmaz/better-npm/src/config/loader.ts` - Config loading with precedence
- `/Users/efebarandurmaz/better-npm/tests/config/config.test.ts` - Comprehensive test suite (22 tests, all passing)
- `/Users/efebarandurmaz/better-npm/examples/config-example.ts` - Usage demonstration

### Test Coverage
- 22 tests passing covering:
  - Schema validation (valid/invalid configs)
  - Type validation (packageManager, logLevel, healthThreshold, telemetry, json, cacheDir)
  - Range validation (healthThreshold 0-100)
  - Unknown key detection
  - Partial config support
  - Default config generation
  - Config loading from multiple sources
  - Precedence ordering
  - Error handling for invalid configs
  - Singleton access patterns

## Task 2.3: Depth Analysis

### Implementation Approach
- Used BFS (Breadth-First Search) from root dependencies to calculate depths
- Tracked visited nodes to handle circular dependencies gracefully
- Built depth distribution map showing packages at each level
- Calculated both max depth and average depth metrics
- Maintained full path chains to identify longest dependency chain

### Key Patterns
1. **BFS Queue Structure**: Each queue node carries `{packageId, depth, path}` for complete chain tracking
2. **Visited Set**: Prevents infinite loops from circular dependencies
3. **Depth Distribution**: Map<number, string[]> allows efficient querying of packages at specific depths
4. **Path Tracking**: Maintains full chain for longest path identification

### Algorithm Characteristics
- Time Complexity: O(V + E) where V=packages, E=dependencies
- Space Complexity: O(V) for visited set and depth maps
- Handles cycles: Yes, via visited set preventing revisits
- Edge case: Empty graph returns maxDepth=0, averageDepth=0, longestChain=[]

### Dependencies
- Created stub `graph.ts` with type definitions since Task 2.1 not yet complete
- Stub allows Task 2.3 to proceed in parallel with other analyzer tasks
- Full graph.ts implementation will replace stub in Task 2.1

## Task 1.1: Install Command Implementation

### Implementation Approach
- Leveraged existing adapter system to detect package manager automatically
- Created reusable spawn utility for child process execution with timing
- Parse install-specific flags: `--dry-run`, `--frozen`, `--production`
- Used inherited stdio for real-time interactive output during install
- Captured timing metrics and exit codes for observability

### Key Patterns
1. **Adapter-based PM Detection**: Used `detectPackageManager()` for automatic detection
2. **Flag Mapping**: Translated generic flags to PM-specific commands via adapter methods
3. **Spawn Utility**: Reusable `spawnWithOutput()` with dual output modes (inherited vs piped)
4. **Real-time Feedback**: Used `inheritStdio: true` for npm/pnpm/yarn native progress indicators
5. **Exit Code Preservation**: Returned actual PM exit code for proper error propagation

### Files Created/Modified
- `/Users/efebarandurmaz/better-npm/src/utils/spawn.ts` - Child process execution utility
- `/Users/efebarandurmaz/better-npm/src/cli/commands/install.ts` - Full install command implementation

### spawn.ts Design
- **ExecResult Interface**: Returns `{exitCode, stdout, stderr, duration}` for all executions
- **Dual Output Mode**: 
  - `inheritStdio: true` - Pass through to terminal (for interactive commands)
  - `inheritStdio: false` - Capture and pipe output (for parsing)
- **Real-time Display**: Even in pipe mode, writes to stdout/stderr for feedback
- **Cross-platform**: Windows shell support via `shell: process.platform === 'win32'`
- **Performance Timing**: Uses `performance.now()` for millisecond precision

### install.ts Features
- **Flag Parsing**: `--dry-run`, `--frozen`, `--production` from `ctx.args.flags`
- **Positional Args**: `ctx.args.positionals` passed to adapter for package names
- **Dry Run Mode**: Shows command without execution for verification
- **Success/Error Reporting**: Uses `ctx.output` methods (log, success, error)
- **Structured Logging**: Logger tracks PM name, duration, exit codes
- **Error Handling**: Try-catch with proper error messages and exit codes

### Adapter Integration
- `detectPackageManager(cwd)` - Returns appropriate adapter (npm/pnpm/yarn)
- `adapter.getInstallCommand(options)` - Builds PM-specific command array
- Options: `{frozen, production, args}` mapped to PM flags
- Example: `frozen: true` → `npm ci`, `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`

### Type Safety
- All TypeScript types properly imported and used
- ParsedArgs interface: `{command, positionals, flags}`
- Output interface: `{log, success, error, warn, json, table}`
- No type errors on `install.ts` or `spawn.ts` (verified with targeted typecheck)

### Build Verification
- `npm run build` succeeds without errors
- Both ESM bundles generated: `dist/cli.js` (27.49 KB), `dist/index.js` (94 B)
- Type declarations generated: `dist/cli.d.ts`, `dist/index.d.ts`

