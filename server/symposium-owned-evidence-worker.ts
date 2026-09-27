import { parseWorkerVertexReceipt } from './symposium-worker-vertex-contract.js';
import {
  parentPort,
  receiveMessageOnPort,
  workerData,
  type MessagePort,
} from 'node:worker_threads';
import { collectOwnedAdmissionEvidence } from './symposium-owned-evidence.js';
import {
  LocalSymposiumProductionPhysicalProof,
  SymposiumPhysicalCleanupError,
} from './symposium-production-physical.js';
import type { OwnedEvidenceWorkerData } from './symposium-owned-evidence-async.js';

const data = workerData as OwnedEvidenceWorkerData;
const port: MessagePort = data.custodyPort;
const signal = new Int32Array(data.signal);
function custody(method: 'custody' | 'native' | 'driver' | 'claude', args: unknown[] = []) {
  Atomics.store(signal, 0, 0);
  port.postMessage({ method, args });
  const deadline = Date.now() + 30_000;
  for (;;) {
    const response = receiveMessageOnPort(port);
    if (response) {
      if (response.message?.ok !== true) throw new Error('Retained owned custody check failed');
      return response.message.receipt;
    }
    if (Date.now() >= deadline) throw new Error('Retained owned custody check timed out');
    Atomics.wait(signal, 0, 0, 20);
  }
}
try {
  const physical = new LocalSymposiumProductionPhysicalProof({
    ...data.physical,
    captureClaudeProvider: (providerId) =>
      parseWorkerVertexReceipt(custody('claude', [providerId])),
    ownedGateway: {
      gateway: data.config.gateway,
      workspace: data.config.workspace,
      endpoint: data.endpoint,
      verifyGatewayDriverConfig: (...args) => custody('driver', args),
      verifyOwnedNativeHost: (...args) => custody('native', args),
    },
  });
  const candidate = collectOwnedAdmissionEvidence(
    { config: data.config, endpoint: data.endpoint, physical, custody: () => custody('custody') },
    data.selection,
  );
  parentPort!.postMessage({ candidate });
} catch (error) {
  parentPort!.postMessage({
    error: true,
    cleanupUncertain: error instanceof SymposiumPhysicalCleanupError,
  });
} finally {
  port.close();
  parentPort!.close();
}
