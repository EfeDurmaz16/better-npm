# Configuration System Architectural Decisions

## Task 0.3: Configuration System

### Key Decisions

#### 1. Validation Strategy
**Decision**: Implement inline validation without external dependencies
**Rationale**:
- Avoid adding Zod as a dependency for a simple CLI tool
- Keep bundle size small
- Full control over error messages and validation logic
- Type-safe validation with TypeScript

#### 2. Configuration Precedence
**Decision**: CLI flags > Environment Variables > Config Files > Defaults
**Rationale**:
- Follows standard Unix/CLI conventions
- Most specific (CLI) overrides most general (defaults)
- Allows temporary overrides without modifying files
- Predictable behavior for users

#### 3. Config File Formats
**Decision**: Support multiple formats: .js, .mjs, .json, .betterrc, package.json#better
**Rationale**:
- Flexibility for different project setups
- JS/MJS allows dynamic configuration
- JSON for static configs
- .betterrc for tool-specific configs
- package.json integration for monorepos

#### 4. Path Resolution
**Decision**: Platform-specific paths following OS conventions
**Rationale**:
- XDG Base Directory on Linux
- ~/Library on macOS
- %LOCALAPPDATA%/%APPDATA% on Windows
- Respects user expectations per platform

#### 5. Singleton Pattern
**Decision**: Global config access via `getConfig()` singleton
**Rationale**:
- Avoids passing config through every function
- Ensures single source of truth
- Must call `loadConfig()` first (fail-fast on misuse)
- Simple API for CLI tools

#### 6. Error Handling
**Decision**: Collect all validation errors, not just first one
**Rationale**:
- Better UX: user sees all problems at once
- Easier debugging
- Standard validation library pattern

### Trade-offs

1. **No async file discovery**: Could use async fs.promises but sync is simpler and fast enough for CLI startup
2. **No config file watching**: Not needed for CLI tool (load once at startup)
3. **No schema migration**: Simple config structure doesn't need versioning yet
4. **No config encryption**: Not handling sensitive data in this layer

## Task 2.3: Depth Analysis

### Key Decisions

#### 1. BFS vs DFS for Depth Calculation
**Decision**: Use BFS (Breadth-First Search)
**Rationale**:
- BFS naturally discovers nodes level-by-level
- Direct mapping to depth concept (level = depth)
- First encounter of a node is at its shallowest depth
- Simpler to implement depth distribution

#### 2. Circular Dependency Handling
**Decision**: Use visited set, skip already-visited nodes
**Rationale**:
- Prevents infinite loops
- Each package counted once at its shallowest depth
- Matches npm/pnpm behavior (first occurrence wins)
- Performance: O(1) lookup per node

#### 3. Longest Chain Tracking
**Decision**: Track full path in each BFS node
**Rationale**:
- Enables complete chain reconstruction
- Useful for debugging deep dependency issues
- Memory overhead acceptable (path arrays are references)
- Alternative (backtracking from end) is more complex

#### 4. Stub graph.ts Creation
**Decision**: Create type-only stub for Task 2.1 dependency
**Rationale**:
- Allows Task 2.3 to proceed without blocking on Task 2.1
- Enables parallel task execution
- Stub provides type definitions only, throws at runtime
- Will be replaced with full implementation in Task 2.1
