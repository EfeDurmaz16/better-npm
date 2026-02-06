// Re-export all analyzer modules
export {
  buildDependencyGraph,
  type DependencyGraph,
  type DependencyNode,
} from './graph.js';

export {
  detectDuplicates,
  type DuplicateReport,
  type DuplicateAnalysis,
  type VersionInfo,
} from './duplicates.js';

export {
  analyzeDepth,
  type DepthAnalysis,
} from './depth.js';

export {
  detectDeprecated,
  type DeprecatedPackage,
  type DeprecationReport,
} from './deprecation.js';
