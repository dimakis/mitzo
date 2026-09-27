import { Worker, MessageChannel, type MessagePort, type WorkerOptions } from 'node:worker_threads';
import { createRequire } from 'node:module';
import type { OpenShellRuntimeConfig } from './openshell-runtime.js';
import type { LocalSymposiumPhysicalOptions } from './symposium-production-physical.js';
import type {
  SymposiumProductionAttestation,
  SymposiumOwnedNativeHostBinding,
} from './symposium-production-gate.js';
import { OwnedEvidenceSelection } from './symposium-owned-evidence.js';

type Physical = Omit<LocalSymposiumPhysicalOptions, 'ownedGateway'>;
export interface OwnedEvidenceWorkerData {
  config: OpenShellRuntimeConfig;
  endpoint: string;
  physical: Physical;
  selection: unknown;
  custodyPort: MessagePort;
  signal: SharedArrayBuffer;
}
interface RetainedCustody {
  verifyCustodyAsync(): Promise<void>;
  verifyOwnedNativeHostAsync(binding: SymposiumOwnedNativeHostBinding): Promise<void>;
  verifyGatewayDriverConfigAsync(
    gateway: string,
    workspace: string,
    driver: 'podman' | 'docker',
  ): Promise<void>;
}
/** A worker runs slow physical probes; only the retained host can answer custody RPC.
 * One active collection per host. Never terminate midway through physical cleanup. */
export function createOwnedEvidenceCollector(
  config: OpenShellRuntimeConfig,
  endpoint: string,
  physical: Physical,
  custody: RetainedCustody,
  spawnWorker: (source: string, options: WorkerOptions) => Worker = (source, options) =>
    new Worker(source, options),
) {
  let active = false;
  let uncertain = false;
  return async (selection: unknown): Promise<SymposiumProductionAttestation> => {
    const parsed = OwnedEvidenceSelection.parse(selection);
    if (uncertain) throw new Error('Evidence worker cleanup requires operator recovery');
    if (active) throw new Error('Admission evidence collection already in progress');
    active = true;
    const { port1, port2 } = new MessageChannel();
    const signal = new SharedArrayBuffer(4);
    try {
      await custody.verifyCustodyAsync();
      const source = import.meta.url.endsWith('.ts');
      const module = new URL(
        source ? './symposium-owned-evidence-worker.ts' : './symposium-owned-evidence-worker.js',
        import.meta.url,
      ).href;
      const worker = spawnWorker(
        source
          ? `const { workerData } = require('node:worker_threads'); require(workerData.loader).register(); require(require('node:url').fileURLToPath(workerData.module));`
          : `const { workerData } = require('node:worker_threads'); import(workerData.module);`,
        {
          eval: true,
          workerData: {
            config,
            endpoint,
            physical,
            selection: parsed,
            custodyPort: port2,
            signal,
            module,
            ...(source ? { loader: createRequire(import.meta.url).resolve('tsx/cjs/api') } : {}),
          },
          transferList: [port2],
        },
      );
      port1.on('message', async (message: { method: string; args: unknown[] }) => {
        let ok = false;
        try {
          if (message.method === 'custody') await custody.verifyCustodyAsync();
          else if (message.method === 'native')
            await custody.verifyOwnedNativeHostAsync(
              message.args[0] as SymposiumOwnedNativeHostBinding,
            );
          else if (message.method === 'driver')
            await custody.verifyGatewayDriverConfigAsync(
              ...(message.args as [string, string, 'podman' | 'docker']),
            );
          else throw new Error('Unknown custody operation');
          ok = true;
        } catch {
          /* Worker receives no private diagnostic output. */
        }
        port1.postMessage({ ok });
        Atomics.store(new Int32Array(signal), 0, 1);
        Atomics.notify(new Int32Array(signal), 0);
      });
      return await new Promise<SymposiumProductionAttestation>((resolve, reject) => {
        let result: SymposiumProductionAttestation | undefined;
        worker.on(
          'message',
          (message: { candidate?: SymposiumProductionAttestation; cleanupUncertain?: boolean }) => {
            if (message.cleanupUncertain) uncertain = true;
            result = message.candidate;
          },
        );
        let workerError = false;
        worker.once('error', () => {
          workerError = true;
        });
        worker.once('exit', (code) => {
          if (code !== 0 || workerError || uncertain) {
            uncertain = true;
            reject(new Error('Evidence worker cleanup requires operator recovery'));
          } else if (!result) reject(new Error('Evidence could not be verified'));
          else custody.verifyCustodyAsync().then(() => resolve(result!), reject);
        });
      });
    } finally {
      port1.close();
      port2.close();
      active = false;
    }
  };
}
