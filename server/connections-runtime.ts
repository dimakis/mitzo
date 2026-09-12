import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ConnectionStore } from './connections-store.js';
import { ConnectionsService } from './connections-service.js';
import { OpenShellConnectionGateway } from './connections-gateway.js';

const exec = promisify(execFile);
export interface ConnectionsRuntime {
  store: ConnectionStore;
  service: ConnectionsService;
  eligibleAccountIds: () => string[];
}
let activeRuntime: ConnectionsRuntime | null = null;
export function setConnectionsRuntime(runtime: ConnectionsRuntime | null) {
  activeRuntime = runtime;
}
export function getConnectionsRuntime() {
  return activeRuntime;
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
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const store = new ConnectionStore(join(options.directory, 'connections.db'));
  const gateway = new OpenShellConnectionGateway(
    async (args, run) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), run.timeoutMs);
      try {
        const signal = AbortSignal.any([run.signal, controller.signal]);
        const result = await exec(options.cli, args, {
          env: {
            PATH: process.env.PATH ?? '',
            HOME: process.env.HOME ?? '',
            TMPDIR: process.env.TMPDIR ?? '',
            LANG: process.env.LANG ?? '',
            LC_ALL: process.env.LC_ALL ?? '',
            ...run.env,
          },
          signal,
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
