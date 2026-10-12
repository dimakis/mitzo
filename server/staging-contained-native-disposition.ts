import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { StagingRecord, StagingRegistration } from './symposium-staging-registry.js';
import {
  canonicalNativeAllocationPaths,
  canonicalStagingRoot,
} from './symposium-staging-identity.js';

/** This recognizes one incident; another owner, source, boot or runtime requires a
 * separately reviewed protocol. This is not original-owner retirement authority. */
export const CONTAINED_NATIVE_INCIDENT = Object.freeze({
  launchId: '37e02cdb-068a-43fe-98e4-e51ed232ce3f',
  instanceId: 'c06d3fea-870a-45c5-9352-85359dd1a214',
  controllerGeneration: 1,
  sourceCommit: '9e301092e418307f772758e8bcab12db8dff65e5',
  buildSha256: '737850c423571ccb20f4e21ff904086023f3c02cff66e136aaba0eff21e5214f',
  configSha256: '81dc11b4e9d22e373c04a3d2a9af6201cd0619a38a699a16775973cc015b8151',
  createdAt: 1791596391790,
});
const canonicalRoot = canonicalStagingRoot();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_. -]{0,199}$/);
const registrationSchema = z.strictObject({
  ownerChat: identifier,
  purpose: identifier,
  retentionReason: identifier,
  reviewAfter: z.number().int().positive(),
  planDirectory: z.string(),
  sourceCommit: commit,
  buildSha256: sha,
  configSha256: sha,
});
const originalSchema = registrationSchema.extend({
  launchId: uuid,
  createdAt: z.number().int().positive(),
  state: z.literal('retirement_uncertain'),
  instanceId: uuid,
  controllerGeneration: z.literal(1),
  retirementStateParent: z.null(),
  completedAt: z.null(),
});
const factsSchema = z.strictObject({
  version: z.literal(1),
  canonicalRoot: z.literal(canonicalRoot),
  capacity: z.literal(1),
  operation: uuid,
  allocation: uuid,
  original: originalSchema,
  archiveRoot: z.string(),
  containmentReceiptSha256: sha,
  recoveryCompletionSha256: sha,
  registryBackupSha256: sha,
  archiveManifestSha256: sha,
  physicalEvidenceSha256: sha,
  acceptedController: commit,
  controllerInventorySha256: sha,
  runtimeConfigurationSha256: sha,
  registration: registrationSchema,
});
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    );
  return value;
}
const digest = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
const refuse = () =>
  Error('Exact authenticated contained-native allocation required; preserve guard and uncertainty');
function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
/** Pure review proposal. Matching JSON or a digest grants no capacity. */
export function createContainedNativeDispositionPlan(input: unknown) {
  if (Buffer.byteLength(JSON.stringify(input) ?? '') > 32768) throw refuse();
  const facts = factsSchema.parse(input);
  if (
    Object.entries(CONTAINED_NATIVE_INCIDENT).some(
      ([key, value]) => facts.original[key as keyof typeof CONTAINED_NATIVE_INCIDENT] !== value,
    ) ||
    facts.original.planDirectory !== join(canonicalRoot, 'symposium/service') ||
    facts.archiveRoot !== canonicalRoot + '-quarantine/' + facts.operation ||
    facts.registration.planDirectory !==
      canonicalNativeAllocationPaths(canonicalRoot, facts.allocation).planDirectory ||
    facts.operation === facts.allocation ||
    facts.registration.sourceCommit === facts.original.sourceCommit
  )
    throw refuse();
  const proposal = {
    version: 1 as const,
    purpose: 'one_canonical_native_allocation_cleanup_unconfirmed' as const,
    executable: false as const,
    capacity: 1 as const,
    nativeCleanupConfirmed: false as const,
    originalRegistryState: 'retirement_uncertain' as const,
    originalRowSha256: digest(facts.original),
    facts,
  };
  return freeze({ ...proposal, sha256: digest(proposal) });
}
export type ContainedNativeDispositionPlan = ReturnType<
  typeof createContainedNativeDispositionPlan
>;
export interface ContainedNativeCapacityLease {
  readonly planSha256: string;
}
interface CurrentLease {
  assertCurrent(): void;
  close(): void;
}
interface OriginalGuard {
  assertCurrent(): void;
}
export interface ContainedNativeDispositionEffects {
  assertAcceptedSource(plan: ContainedNativeDispositionPlan): Promise<void>;
  acquireGuard(plan: ContainedNativeDispositionPlan): Promise<OriginalGuard>;
  assertNoPriorDisposition(plan: ContainedNativeDispositionPlan): Promise<void>;
  /** Must fully read/verify completed containment, both completion records, exact
   * unchanged registry row/backup, complete archive bytes and physical exclusion.
   * Receipt hashes, timestamps or a stopped VM alone cannot implement this. */
  verifyCompletedContainment(plan: ContainedNativeDispositionPlan): Promise<void>;
  /** Existing providers-off ordinary helper is expressly insufficient. */
  authenticateNativeAllocation(
    sha256: string,
    purpose: ContainedNativeDispositionPlan['purpose'],
  ): Promise<unknown>;
  consumeOperatorAuthority(
    authority: unknown,
    sha256: string,
    purpose: ContainedNativeDispositionPlan['purpose'],
  ): CurrentLease;
  /** Append-only incident-specific ledger under the ORIGINAL deployment guard;
   * must CAS unchanged original row and capacity1. A ledger never mints a lease. */
  appendDisposition(plan: ContainedNativeDispositionPlan): Promise<void>;
}
interface Grant {
  plan: ContainedNativeDispositionPlan;
  guard: OriginalGuard;
  auth: CurrentLease;
  wallDeadline: number;
  monotonicDeadline: number;
  used: boolean;
  closed: boolean;
}
const grants = new WeakMap<object, Grant>();
/** Refusal may happen before SQLite admission. It still burns this original
 * attempt; this revoker cannot construct or extend an admission capability. */
export function revokeContainedNativeCapacityLease(lease: unknown) {
  if (lease && typeof lease === 'object') {
    const grant = grants.get(lease);
    if (grant) grant.used = true;
  }
}
/** Only accepted original-process wiring supplies these trusted effects. No CLI
 * loads callbacks or authentication from JSON. Physical host adapters are separate
 * required integration; without them this source exposes no executable command. */
export function createContainedNativeDispositionOwner(effects: ContainedNativeDispositionEffects) {
  for (const name of [
    'assertAcceptedSource',
    'acquireGuard',
    'assertNoPriorDisposition',
    'verifyCompletedContainment',
    'authenticateNativeAllocation',
    'consumeOperatorAuthority',
    'appendDisposition',
  ] as const)
    if (typeof effects?.[name] !== 'function') throw refuse();
  let attempted = false;
  return Object.freeze({
    async authorize(selected: ContainedNativeDispositionPlan) {
      if (attempted) throw refuse();
      attempted = true;
      const plan = createContainedNativeDispositionPlan(selected.facts);
      if (digest(plan) !== digest(selected)) throw refuse();
      await effects.assertAcceptedSource(plan);
      const guard = await effects.acquireGuard(plan);
      const assertGuard = () => guard.assertCurrent();
      let auth: CurrentLease | undefined;
      try {
        assertGuard();
        await effects.assertAcceptedSource(plan);
        assertGuard();
        await effects.assertNoPriorDisposition(plan);
        assertGuard();
        await effects.verifyCompletedContainment(plan);
        assertGuard();
        const authority = await effects.authenticateNativeAllocation(plan.sha256, plan.purpose);
        assertGuard();
        auth = effects.consumeOperatorAuthority(authority, plan.sha256, plan.purpose);
        const current = () => {
          assertGuard();
          auth!.assertCurrent();
        };
        current();
        await effects.assertAcceptedSource(plan);
        current();
        await effects.verifyCompletedContainment(plan);
        current();
        await effects.assertNoPriorDisposition(plan);
        current();
        await effects.appendDisposition(plan);
        current();
        await effects.verifyCompletedContainment(plan);
        current();
        const lease = Object.freeze({ planSha256: plan.sha256 });
        const grant: Grant = {
          plan,
          guard,
          auth,
          wallDeadline: Date.now() + 600000,
          monotonicDeadline: performance.now() + 600000,
          used: false,
          closed: false,
        };
        grants.set(lease, grant);
        return Object.freeze({
          lease,
          close() {
            grant.closed = true;
            auth!.close();
          },
        });
      } catch (error) {
        auth?.close();
        // Never release, remove or recreate the deployment guard after uncertainty.
        throw error;
      }
    },
  });
}
/** Registry-only synchronous consumption inside its immediate transaction. JSON
 * cannot recreate the WeakMap brand; failure burns the exact original lease. */
export function consumeContainedNativeCapacityLease(
  lease: unknown,
  directory: string,
  capacity: number,
  registration: StagingRegistration,
  rows: StagingRecord[],
) {
  if (!lease || typeof lease !== 'object') throw refuse();
  const grant = grants.get(lease);
  if (!grant || grant.used || grant.closed) throw refuse();
  grant.used = true;
  grant.guard.assertCurrent();
  grant.auth.assertCurrent();
  if (
    Date.now() >= grant.wallDeadline ||
    performance.now() >= grant.monotonicDeadline ||
    capacity !== 1 ||
    directory !== join(canonicalRoot, 'registry') ||
    digest(registration) !== digest(grant.plan.facts.registration) ||
    rows.length !== 1 ||
    digest(rows[0]) !== grant.plan.originalRowSha256
  )
    throw refuse();
  return grant.plan.facts.original.launchId;
}
