import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { codexPrivateDirectory } from './codex-private-path.js';
import { ConfiguredToolCatalog } from './configured-tool-catalog.js';
let active: { path: string; catalog: ConfiguredToolCatalog } | undefined;
export function getConfiguredToolCatalog(): ConfiguredToolCatalog {
  const directory = codexPrivateDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'configured-tools.db');
  if (!active || active.path !== path) {
    active?.catalog.close();
    active = { path, catalog: new ConfiguredToolCatalog(path) };
  }
  return active.catalog;
}
