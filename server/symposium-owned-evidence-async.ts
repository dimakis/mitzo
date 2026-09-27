import {
  WorkerVertexRequest,
  parseWorkerVertexReceipt,
} from './symposium-worker-vertex-contract.js';
import type { SymposiumWorkVertexReceipt } from './symposium-work-vertex-provider.js';
import { Worker, MessageChannel, type MessagePort, type WorkerOptions } from 'node:worker_threads';
import { createRequire } from 'node:module';
import type { OpenShellRuntimeConfig } from './openshell-runtime.js';
import type { LocalSymposiumPhysicalOptions } from './symposium-production-physical.js';
import type {
  SymposiumProductionAttestation,
  SymposiumOwnedNativeHostBinding,
} from './symposium-production-gate.js';
import { OwnedEvidenceSelection } from './symposium-owned-evidence.js';

type Physical = Omit<LocalSymposiumPhysicalOptions, 'ownedGateway' | 'captureClaudeProvider'>;
export interface OwnedEvidenceWorkerData {
  config: OpenShellRuntimeConfig;
  endpoint: string;
  physical: Physical;
  selection: unknown;
  custodyPort: MessagePort;
  signal: SharedArrayBuffer;
}
interface RetainedCustody {
  captureClaudeProviderAsync?(providerId: string): Promise<SymposiumWorkVertexReceipt>;
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
    const selected = new Map(
      parsed.providerInstances.filter((p) => p.type === 'google-vertex-ai').map((p) => [p.id, p]),
    );
    const receipts = new Map<string, SymposiumWorkVertexReceipt>();
    const capture = async (id: string) => {
      const provider = selected.get(id);
      if (!provider || !custody.captureClaudeProviderAsync)
        throw Error('Evidence provider custody unavailable');
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const receipt = parseWorkerVertexReceipt(
          await Promise.race([
            custody.captureClaudeProviderAsync(id),
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(
                () => reject(Error('Evidence provider custody timed out')),
                10_000,
              );
            }),
          ]),
        );
        if (
          receipt.providerId !== id ||
          receipt.provider !== provider.name ||
          receipt.workspace !== config.workspace
        )
          throw Error('Evidence provider identity changed');
        return receipt;
      } catch {
        throw Error('Evidence provider custody unavailable');
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    };
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
        let receipt: SymposiumWorkVertexReceipt | undefined;
        try {
          if (message.method === 'claude') {
            const request = WorkerVertexRequest.parse(message);
            receipt = await capture(request.args[0]);
            const previous = receipts.get(request.args[0]);
            if (previous && JSON.stringify(previous) !== JSON.stringify(receipt))
              throw Error('Evidence provider changed');
            receipts.set(request.args[0], receipt);
          } else if (message.method === 'custody') await custody.verifyCustodyAsync();
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
        port1.postMessage({ ok, ...(ok && receipt ? { receipt } : {}) });
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
          else
            void (async () => {
              await custody.verifyCustodyAsync();
              for (const id of selected.keys()) {
                const before = receipts.get(id);
                if (!before || JSON.stringify(await capture(id)) !== JSON.stringify(before))
                  throw Error('Evidence provider changed after physical probe');
              }
              await custody.verifyCustodyAsync();
              resolve(result!);
            })().catch(() => reject(Error('Evidence retained custody could not be verified')));
        });
      });
    } finally {
      port1.close();
      port2.close();
      active = false;
    }
  };
}
