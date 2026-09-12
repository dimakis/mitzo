import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { ConnectionStore } from './connections-store.js';
import { ConnectionsService } from './connections-service.js';
import { OpenShellConnectionGateway } from './connections-gateway.js';

const exec = promisify(execFile);
export interface ConnectionsRuntime {
  store: ConnectionStore;
  service: ConnectionsService;
  eligibleAccountIds: () => string[];
}

/** Explicit bootstrap: no gateway process or filesystem work occurs at import. */
export function createConnectionsRuntime(options: {
  directory: string;
  eligibleAccountIds: () => string[];
  cli: string;
  workspace: string;
  probeImage?: string;
  probePolicy?: string;
}): ConnectionsRuntime {
  const store = new ConnectionStore(join(options.directory, 'connections.db'));
  const gateway = new OpenShellConnectionGateway(
    async (args, run) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), run.timeoutMs);
      try {
        const result = await exec(options.cli, args, {
          env: { PATH: process.env.PATH ?? '', ...run.env },
          signal: controller.signal,
          maxBuffer: 128 * 1024,
        });
        return result.stdout;
      } finally {
        clearTimeout(timer);
      }
    },
    {
      workspace: options.workspace,
      probeImage: options.probeImage,
      probePolicy: options.probePolicy,
    },
  );
  return {
    store,
    service: new ConnectionsService(store, gateway),
    eligibleAccountIds: options.eligibleAccountIds,
  };
}
