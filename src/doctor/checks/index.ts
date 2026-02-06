export { duplicatesCheck } from './duplicates.js';
export { deprecatedCheck } from './deprecated.js';
export { depthCheck } from './depth.js';
export { sizeCheck } from './size.js';

import { duplicatesCheck } from './duplicates.js';
import { deprecatedCheck } from './deprecated.js';
import { depthCheck } from './depth.js';
import { sizeCheck } from './size.js';

export const allChecks = [
  duplicatesCheck,
  deprecatedCheck,
  depthCheck,
  sizeCheck,
];
