import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { codexPrivateDirectory } from './codex-private-path.js';
import { ApiToolCatalog } from './api-tool-catalog.js';
let active: { path: string; catalog: ApiToolCatalog } | undefined;
export function getApiToolCatalog(): ApiToolCatalog {
  const directory = codexPrivateDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'api-tools.db');
  if (!active || active.path !== path) {
    active?.catalog.close();
    active = { path, catalog: new ApiToolCatalog(path) };
  }
  return active.catalog;
}
