import { z } from 'zod';
import type { OwnedReleasePlan } from './symposium-owned-release.js';
import type { CustodianRetirementReceipt } from './symposium-custodian-retirement.js';
import { dirname } from 'node:path';
const pid = z.number().int().min(2).max(2147483647);
const processIdentity = z.strictObject({
  pid,
  birth: z.string().min(1).max(128),
  cwd: z.string().min(1),
});
export const CanonicalOwnerSchema = z.strictObject({
  version: z.literal(1),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  configSha256: z.string().regex(/^[a-f0-9]{64}$/),
  buildSha256: z.string().regex(/^[a-f0-9]{64}$/),
  instanceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/),
  epoch: z.number().int().positive(),
  capturedAt: z.number().int().positive(),
  parent: processIdentity,
  app: processIdentity.extend({ parentPid: pid }),
});
export type CanonicalOwner = z.infer<typeof CanonicalOwnerSchema>;
export interface CanonicalRegistryObservation {
  planDirectory: string;
  sourceCommit: string;
  configSha256: string;
  buildSha256: string;
  state: string;
  instanceId: string | null;
  controllerGeneration: number;
  createdAt: number;
  completedAt?: number | null;
  retirementStateParent?: string | null;
}
export interface CanonicalRuntimeObservation {
  jobPid: number;
  parent: CanonicalOwner['parent'];
  app: CanonicalOwner['app'];
  portPids: number[];
  protectedPids: number[];
}
/** Operator identity check only. A receipt never restores native custody. */
export function assertCanonicalOwnerRuntime(
  plan: OwnedReleasePlan,
  input: CanonicalOwner,
  registry: CanonicalRegistryObservation,
  runtime: CanonicalRuntimeObservation,
) {
  const owner = CanonicalOwnerSchema.parse(input);
  const same = (a: CanonicalOwner['parent'], b: CanonicalOwner['parent']) =>
    a.pid === b.pid && a.birth === b.birth && a.cwd === b.cwd;
  if (
    owner.parent.pid === owner.app.pid ||
    owner.sourceCommit !== plan.sourceCommit ||
    owner.configSha256 !== plan.configSha256 ||
    owner.buildSha256 !== plan.buildSha256 ||
    owner.parent.cwd !== plan.releaseRoot ||
    owner.app.cwd !== plan.releaseRoot ||
    owner.app.parentPid !== owner.parent.pid ||
    registry.planDirectory !== plan.planDirectory ||
    registry.sourceCommit !== plan.sourceCommit ||
    registry.configSha256 !== plan.configSha256 ||
    registry.buildSha256 !== plan.buildSha256 ||
    registry.state !== 'active' ||
    registry.instanceId !== owner.instanceId ||
    registry.controllerGeneration !== owner.epoch ||
    registry.createdAt > owner.capturedAt ||
    runtime.jobPid !== owner.parent.pid ||
    !same(owner.parent, runtime.parent) ||
    !same(owner.app, runtime.app) ||
    runtime.app.parentPid !== owner.parent.pid ||
    runtime.portPids.length !== 1 ||
    runtime.portPids[0] !== owner.app.pid ||
    runtime.protectedPids.some((p) => [owner.parent.pid, owner.app.pid].includes(p))
  )
    throw Error('Original canonical parent/app identity mismatch; refuse control');
}
export function assertCanonicalOwnerRetired(
  owner: CanonicalOwner,
  registry: CanonicalRegistryObservation,
  receipt: CustodianRetirementReceipt | null,
  requestedAt: number,
) {
  if (
    !receipt ||
    registry.state !== 'retired' ||
    registry.sourceCommit !== owner.sourceCommit ||
    registry.configSha256 !== owner.configSha256 ||
    registry.buildSha256 !== owner.buildSha256 ||
    registry.instanceId !== owner.instanceId ||
    registry.controllerGeneration !== owner.epoch ||
    receipt.instanceId !== owner.instanceId ||
    receipt.controllerGeneration !== owner.epoch ||
    receipt.completedAt !== registry.completedAt ||
    receipt.completedAt < requestedAt ||
    receipt.completedAt < owner.capturedAt ||
    dirname(receipt.gatewayStateDirectory) !== registry.retirementStateParent
  )
    throw Error('Original custodian retirement is not confirmed');
}
/** No restart, takeover, force kill, lock deletion or rollback path exists. */
export async function drainCanonicalOwner(effects: {
  lock(): Promise<void>;
  validate(): Promise<void>;
  stop(): Promise<void>;
  verifyRetired(): Promise<void>;
  unlock(): Promise<void>;
  audit(state: 'verified' | 'refused' | 'uncertain'): Promise<void>;
}) {
  await effects.lock();
  let attempted = false;
  try {
    await effects.validate();
    attempted = true;
    await effects.stop();
    await effects.verifyRetired();
    await effects.audit('verified');
  } catch (error) {
    await effects.audit(attempted ? 'uncertain' : 'refused');
    if (!attempted) await effects.unlock();
    throw error;
  }
  await effects.unlock();
}
