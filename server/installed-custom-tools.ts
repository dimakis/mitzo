import type { InstalledCustomTool } from './custom-tool-registry.js';

/** Code-owned inventory only. Add static imports and reviewed artifact mappings
 * in the same accepted source change as a new implementation. Nothing is
 * discovered, uploaded or loaded from a draft directory at runtime. */
export const installedCustomTools: readonly InstalledCustomTool[] = Object.freeze([]);
