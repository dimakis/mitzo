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
import type { OwnedEvidencePhase } from './symposium-owned-evidence-diagnostic.js';

const data = workerData as OwnedEvidenceWorkerData;
const port: MessagePort = data.custodyPort;
const signal = new Int32Array(data.signal);
let phase: OwnedEvidencePhase = 'physical-init';
const physicalMethods: Partial<
  Record<keyof LocalSymposiumProductionPhysicalProof, OwnedEvidencePhase>
> = {
  verifyOwnedNativeHost: 'custody-native',
  verifyNativeArtifacts: 'verify-native-artifacts',
  verifyImageAndController: 'verify-image',
  verifyProviderProfile: 'verify-profile',
  verifyProviderInstance: 'verify-provider',
  verifyGatewayDriverConfig: 'verify-driver',
  verifyArtifactVolume: 'verify-volume',
  captureClaudeProvider: 'custody-claude',
};
function custody(method: 'custody' | 'native' | 'driver' | 'claude', args: unknown[] = []) {
  const previousPhase = phase;
  phase =
    method === 'custody'
      ? 'custody'
      : method === 'native'
        ? 'custody-native'
        : method === 'driver'
          ? 'custody-driver'
          : 'custody-claude';
  Atomics.store(signal, 0, 0);
  port.postMessage({ method, args });
  const deadline = Date.now() + 30_000;
  for (;;) {
    const response = receiveMessageOnPort(port);
    if (response) {
      if (response.message?.ok !== true) throw new Error('Retained owned custody check failed');
      phase = previousPhase;
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
  const phasedPhysical = new Proxy(physical, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof key !== 'string' || typeof value !== 'function') return value;
      const methodPhase = physicalMethods[key as keyof LocalSymposiumProductionPhysicalProof];
      if (!methodPhase) return value.bind(target);
      return (...args: unknown[]) => {
        const previousPhase = phase;
        phase = methodPhase;
        const result = value.apply(target, args);
        phase = previousPhase;
        return result;
      };
    },
  });
  const candidate = collectOwnedAdmissionEvidence(
    {
      config: data.config,
      buildSelection: data.buildSelection,
      endpoint: data.endpoint,
      physical: phasedPhysical,
      custody: () => custody('custody'),
    },
    data.selection,
    {
      onPhase: (next) => {
        phase = next;
      },
    },
  );
  parentPort!.postMessage({ candidate });
} catch (error) {
  parentPort!.postMessage({
    error: true,
    phase,
    cleanupUncertain: error instanceof SymposiumPhysicalCleanupError,
  });
} finally {
  port.close();
  parentPort!.close();
}
