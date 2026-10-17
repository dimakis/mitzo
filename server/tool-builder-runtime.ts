import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { codexPrivateDirectory } from './codex-private-path.js';
import { custodianControllerMode, custodianOwnerMode } from './symposium-custodian-mode.js';
import {
  reviewedConnectionsRuntimeImplementationRevision,
  reviewedHandlerSourceArtifacts,
} from './connections/reviewed-handler-artifacts.js';
import { installedCustomTools } from './installed-custom-tools.js';
import { CustomToolRegistry } from './custom-tool-registry.js';
import { ToolBuilderStore } from './tool-builder-store.js';

const registry = new CustomToolRegistry(() => ({
  entries: installedCustomTools,
  artifacts: reviewedHandlerSourceArtifacts,
  revision: reviewedConnectionsRuntimeImplementationRevision,
}));
let active: { path: string; store: ToolBuilderStore } | undefined;
export function getToolBuilderStore(): ToolBuilderStore {
  if (custodianControllerMode || custodianOwnerMode)
    throw Error(
      'Tool Builder development and custom tool execution are not enrolled on custodian routes',
    );
  const directory = codexPrivateDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'tool-builder.db');
  if (!active || active.path !== path) {
    active?.store.close();
    active = { path, store: new ToolBuilderStore(path, registry) };
  }
  return active.store;
}
