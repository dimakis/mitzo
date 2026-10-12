import { StagingOwnedCleanup } from './staging-feature-cleanup.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { AccountBinding } from '@mitzo/protocol';
import type { ManagedSession } from '@mitzo/harness';
import type { AccountProfiles } from './account-profiles.js';
import { collectStagingTextReadEvidence } from './staging-feature-evidence.js';
import type { startChat, stopChat, registry } from './chat.js';
import type { EventStore } from './event-store.js';
import { custodianControllerMode, custodianOwnerMode } from './symposium-custodian-mode.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
export const StagingFeatureRequest = z.strictObject({
  version: z.literal(2),
  id,
  pr: z.number().int().positive(),
  taskId: id,
  acceptedCommit: commit,
  suite: z.literal('profile-tools-v1'),
  profileId: id,
  enrollmentRevision: sha,
});
export const StagingFeatureToken = z.strictObject({
  epoch: z.number().int().positive(),
  requestId: id,
  owner: id,
  nonce: id,
});
const modelOrAccount = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/);
export const StagingAcceptedAppSource = z.strictObject({
  nativeSourceCommit: commit,
  acceptedAppCommit: commit,
  appRoot: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => value.startsWith('/')),
  instanceId: id,
  custodianPid: z.number().int().positive(),
  epoch: z.number().int().positive(),
  controllerPid: z.number().int().positive(),
  compatibilitySha256: sha,
});
export const StagingFeaturePlan = z
  .strictObject({
    version: z.literal(1),
    requestId: id,
    sourceCommit: commit,
    nativeSourceCommit: commit.optional(),
    acceptedAppSource: StagingAcceptedAppSource.optional(),
    profileId: id,
    enrollmentRevision: sha,
    profileRevision: sha,
    provider: id,
    runtime: id,
    runtimeRevision: sha,
    ownerInstance: id,
    chargedAccount: modelOrAccount,
    selectedModel: modelOrAccount,
    modelApprovalId: id.nullable(),
    suite: z.literal('profile-tools-v1'),
    suiteRevision: sha,
    runnerRevision: sha,
    modelDispatches: z.tuple([
      z.strictObject({
        purpose: z.enum(['main', 'all-inference']),
        chargedAccount: modelOrAccount,
        selectedModel: modelOrAccount,
        maxModelRounds: z.literal(2),
      }),
    ]),
    auxiliaryDispatches: z.enum(['disabled', 'same-selected-model-shared-budget']),
    limits: z.strictObject({
      maxProviderDispatches: z.literal(1),
      timeoutMs: z.number().int().min(1000).max(180000),
      maxOutputBytes: z.number().int().positive().max(65536),
    }),
  })
  .superRefine((plan, context) => {
    const scope = plan.modelDispatches[0];
    if (
      scope.chargedAccount !== plan.chargedAccount ||
      scope.selectedModel !== plan.selectedModel ||
      (plan.auxiliaryDispatches === 'disabled'
        ? scope.purpose !== 'main'
        : scope.purpose !== 'all-inference' || plan.runtime !== 'openshell-native')
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Exact shared inference scope required',
      });
    if (
      !/^gpt-\d+(?:\.\d+)?-luna$/.test(plan.selectedModel) &&
      !(
        plan.provider === 'anthropic-vertex' &&
        plan.selectedModel === 'claude-haiku-4-5@20251001' &&
        plan.modelApprovalId
      )
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Supported Luna or exact authenticated Vertex Haiku approval required',
      });
    if (
      Boolean(plan.nativeSourceCommit) !== Boolean(plan.acceptedAppSource) ||
      (plan.acceptedAppSource &&
        (plan.runtime !== 'openshell-native' ||
          plan.acceptedAppSource.nativeSourceCommit !== plan.nativeSourceCommit ||
          plan.acceptedAppSource.acceptedAppCommit !== plan.sourceCommit ||
          plan.acceptedAppSource.instanceId !== plan.ownerInstance))
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Paired native/accepted app source observations required',
      });
  });
export type StagingFeaturePlanValue = z.infer<typeof StagingFeaturePlan>;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const suiteRevision = digest([
  'profile-tools-v1',
  'stream-text',
  'context-read',
  'one-fresh-session',
  'owned-cleanup',
]);
const runnerRevision = createHash('sha256')
  .update(readFileSync(new URL(import.meta.url)))
  .digest('hex');
export interface StagingFeatureEnrollment {
  profileId: string;
  enrollmentRevision: string;
  binding: AccountBinding;
  runtime: 'local-codex' | 'local-responses';
  runtimeRevision: string;
  chargedAccount: string;
  selectedModel: string;
  modelApprovalId: string | null;
}

/** Trusted bootstrap capabilities, not HTTP/JSON authority. Installation must
 * independently qualify accepted source, actual canonical owner and fresh stage
 * enrollment. Default app bootstrap installs none. Native routes require their
 * existing original-owner adapter; they cannot use this ordinary local port. */
export interface StagingFeatureOwnerAuthority {
  sourceCommit: string;
  ownerInstance: string;
  fixtureDirectory: string;
  currentProfiles(): AccountProfiles;
  enrollment(profileId: string): StagingFeatureEnrollment;
  assertOriginalOwner(): void;
  assertFreshAuthorization(enrollment: StagingFeatureEnrollment): void;
  assertModelApproval(enrollment: StagingFeatureEnrollment): void;
  /** Must call the accepted actual queue guard, with root from this verified
   * bootstrap: assertStagingPipelineFeatureDispatch({sourceCommit,token,planSha256,plan},{root}). */
  assertReservation(
    plan: StagingFeaturePlanValue,
    token: z.infer<typeof StagingFeatureToken>,
    planSha256: string,
  ): void;
  port: {
    startChat: typeof startChat;
    stopChat: typeof stopChat;
    registry: typeof registry;
    eventStore: EventStore;
    isAllowedPath(path: string): boolean;
  };
}

export class StagingFeatureOwner {
  private active = false;
  private readonly dispatchedRequests = new Set<string>();
  private readonly pendingCleanup = new Map<
    string,
    { cleanup: StagingOwnedCleanup; fixture?: string }
  >();
  private readonly receipts = new Map<string, { receipt: unknown; ownerReceiptSha256: string }>();
  constructor(private readonly authority: StagingFeatureOwnerAuthority) {}
  private selected(profileId: string) {
    this.authority.assertOriginalOwner();
    if (
      custodianControllerMode ||
      custodianOwnerMode ||
      process.env.MITZO_OPENSHELL_ENABLED !== '0'
    )
      throw new Error('Local staging features require a qualified ordinary owner');
    const enrollment = this.authority.enrollment(profileId);
    if (
      enrollment.profileId !== profileId ||
      !sha.safeParse(enrollment.enrollmentRevision).success ||
      !sha.safeParse(enrollment.runtimeRevision).success ||
      !(
        (enrollment.binding.provider === 'openai-codex' && enrollment.runtime === 'local-codex') ||
        (enrollment.binding.provider === 'openai' && enrollment.runtime === 'local-responses')
      )
    )
      throw new Error('Selected staging feature adapter unavailable');
    // The pinned Codex app-server's automatic compaction route has no accepted
    // disabled/explicit-model proof in this suite yet. Small input is not proof.
    if (enrollment.runtime === 'local-codex')
      throw new Error('Codex auxiliary model dispatch qualification pending');
    this.authority.assertFreshAuthorization(enrollment);
    const profiles = this.authority.currentProfiles();
    profiles.resume(enrollment.binding);
    profiles.validateModelSelection(enrollment.binding, enrollment.selectedModel);
    if (!/^gpt-\d+(?:\.\d+)?-luna$/.test(enrollment.selectedModel)) {
      if (!id.safeParse(enrollment.modelApprovalId).success)
        throw new Error('Explicit staging model approval unavailable');
      this.authority.assertModelApproval(enrollment);
    }
    return { enrollment, profiles };
  }
  enrollment(profileId: string) {
    const { enrollment } = this.selected(profileId);
    return { profileId, enrollmentRevision: enrollment.enrollmentRevision };
  }
  plan(value: unknown, sourceCommit: string) {
    const request = StagingFeatureRequest.parse(value);
    const { enrollment } = this.selected(request.profileId);
    if (
      sourceCommit !== this.authority.sourceCommit ||
      request.enrollmentRevision !== enrollment.enrollmentRevision
    )
      throw new Error('Staging feature source or enrollment changed');
    const plan = StagingFeaturePlan.parse({
      version: 1,
      requestId: request.id,
      sourceCommit,
      profileId: request.profileId,
      enrollmentRevision: enrollment.enrollmentRevision,
      profileRevision: enrollment.binding.profileRevision,
      provider: enrollment.binding.provider,
      runtime: enrollment.runtime,
      runtimeRevision: enrollment.runtimeRevision,
      ownerInstance: this.authority.ownerInstance,
      chargedAccount: enrollment.chargedAccount,
      selectedModel: enrollment.selectedModel,
      modelApprovalId: enrollment.modelApprovalId,
      suite: request.suite,
      suiteRevision,
      runnerRevision,
      modelDispatches: [
        {
          purpose: 'main',
          chargedAccount: enrollment.chargedAccount,
          selectedModel: enrollment.selectedModel,
          maxModelRounds: 2,
        },
      ],
      auxiliaryDispatches: 'disabled',
      limits: { maxProviderDispatches: 1, timeoutMs: 180000, maxOutputBytes: 65536 },
    });
    return { plan, planSha256: digest(plan) };
  }
  async run(value: unknown, reservation: unknown) {
    const plan = StagingFeaturePlan.parse(value),
      token = StagingFeatureToken.parse(reservation);
    const { enrollment, profiles } = this.selected(plan.profileId);
    const planSha256 = digest(plan);
    const assertCurrent = () => {
      this.authority.assertOriginalOwner();
      this.authority.assertFreshAuthorization(enrollment);
      this.authority.assertReservation(plan, token, planSha256);
      const current = this.selected(plan.profileId).enrollment;
      if (
        plan.sourceCommit !== this.authority.sourceCommit ||
        plan.ownerInstance !== this.authority.ownerInstance ||
        plan.suiteRevision !== suiteRevision ||
        plan.runnerRevision !== runnerRevision ||
        plan.enrollmentRevision !== current.enrollmentRevision ||
        plan.profileRevision !== current.binding.profileRevision ||
        plan.provider !== current.binding.provider ||
        plan.runtime !== current.runtime ||
        plan.runtimeRevision !== current.runtimeRevision ||
        plan.chargedAccount !== current.chargedAccount ||
        plan.selectedModel !== current.selectedModel ||
        plan.modelApprovalId !== current.modelApprovalId ||
        plan.modelDispatches[0].chargedAccount !== current.chargedAccount ||
        plan.modelDispatches[0].selectedModel !== current.selectedModel ||
        token.requestId !== plan.requestId
      )
        throw new Error('Staging feature plan changed');
    };
    assertCurrent();
    if (
      this.active ||
      this.dispatchedRequests.size >= 100 ||
      this.dispatchedRequests.has(plan.requestId)
    )
      throw new Error('Staging feature runner unavailable');
    this.dispatchedRequests.add(plan.requestId);
    this.active = true;
    let fixture: string | undefined;
    let query: ManagedSession['queryInstance'];
    let cleanup:
      | Awaited<
          ReturnType<NonNullable<NonNullable<ManagedSession['queryInstance']>['closeAndConfirm']>>
        >
      | undefined;
    const runId = randomUUID(),
      sessionId = randomUUID(),
      commandId = `staging-feature-${runId}`,
      clientId = `staging-feature:${runId}`;
    const ownedCleanup = new StagingOwnedCleanup();
    const retainedRun = { cleanup: ownedCleanup, fixture: undefined as string | undefined };
    this.pendingCleanup.set(runId, retainedRun);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let closeResult: Promise<void> | undefined;
    try {
      assertCurrent();
      fixture = await mkdtemp(join(this.authority.fixtureDirectory, 'text-read-'));
      retainedRun.fixture = fixture;
      if (!this.authority.port.isAllowedPath(fixture))
        throw new Error('Staging fixture outside the reviewed workspace');
      const fixturePath = join(fixture, 'nonce.txt'),
        nonce = randomUUID();
      await writeFile(fixturePath, nonce, { mode: 0o600, flag: 'wx' });
      let modelRounds = 0;
      const finish = async () => {
        if (!query?.closeAndConfirm) throw new Error('Original adapter cleanup unavailable');
        await ownedCleanup.confirm(5000);
        cleanup = await query.closeAndConfirm();
        if (cleanup.runtime !== plan.runtime) throw new Error('Original adapter cleanup changed');
        this.authority.port.stopChat(clientId);
      };
      assertCurrent();
      const running = this.authority.port.startChat(
        { isOpen: () => true, send: () => {} },
        clientId,
        `Use Read exactly once to read ${fixturePath}. Reply with the file contents. Use no other tools.`,
        {
          initialSessionId: sessionId,
          clientMsgId: commandId,
          cwd: fixture,
          mode: 'ask',
          isolation: false,
          retainWorkspace: true,
          accountId: enrollment.binding.accountId,
          model: enrollment.selectedModel,
          accountProfiles: profiles,
          stagingFeature: {
            beforeDispatch: () => {
              assertCurrent();
              if (++modelRounds > 5) throw new Error('Staging model/tool dispatch budget exceeded');
            },
            maxModelRounds: 2,
            fixturePath,
            retainCleanup: (close) => ownedCleanup.retain(close),
          },
          onQueryReady: () => {
            query = this.authority.port.registry.get(clientId)?.queryInstance;
          },
          onTurnResult: () => {
            closeResult ??= finish();
            void closeResult.catch(() => {});
          },
        },
      );
      await Promise.race([
        running,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            closeResult ??= finish();
            void closeResult.catch(() => {});
            reject(new Error('Staging feature deadline exceeded'));
          }, plan.limits.timeoutMs);
        }),
      ]);
      closeResult ??= finish();
      await closeResult;
      if (!cleanup) throw new Error('Original adapter cleanup unconfirmed');
      assertCurrent();
      const evidence = collectStagingTextReadEvidence(this.authority.port.eventStore, {
        sessionId,
        commandId,
        binding: enrollment.binding,
        selectedModel: enrollment.selectedModel,
        fixturePath,
        nonce,
        afterSeq: 0,
      });
      if (
        (await readdir(fixture)).join() !== 'nonce.txt' ||
        (await readFile(fixturePath, 'utf8')) !== nonce
      )
        throw new Error('Staging fixture changed');
      await rm(fixture, { recursive: true });
      fixture = undefined;
      const receipt = {
        version: 1,
        plan,
        planSha256,
        runId,
        evidence,
        cleanup,
        cleanupConfirmed: true,
      };
      const ownerReceiptSha256 = digest(receipt);
      this.receipts.set(runId, { receipt, ownerReceiptSha256 });
      this.pendingCleanup.delete(runId);
      return {
        outcome: 'passed' as const,
        sourceCommit: plan.sourceCommit,
        cleanupConfirmed: true as const,
        featureResult: {
          version: 1 as const,
          profileId: plan.profileId,
          enrollmentRevision: plan.enrollmentRevision,
          planSha256,
          ownerInstance: plan.ownerInstance,
          runId,
          ownerReceiptSha256,
        },
      };
    } catch {
      // Failure retains the queue reservation. Only genuine adapter acknowledgment
      // permits removing the original fixture; absence alone never qualifies it.
      if (query?.closeAndConfirm && !cleanup) {
        try {
          await ownedCleanup.confirm(5000);
          cleanup = await query.closeAndConfirm();
        } catch {
          /* Retain custody. */
        }
      }
      if (!query) {
        try {
          await ownedCleanup.confirm(5000);
        } catch {
          /* Retain pre-query capabilities. */
        }
      }
      if (ownedCleanup.confirmed && fixture) {
        await rm(fixture, { recursive: true });
      }
      throw new Error('Staging feature run requires original-owner reconciliation');
    } finally {
      if (timeout) clearTimeout(timeout);
      if (ownedCleanup.confirmed) {
        this.pendingCleanup.delete(runId);
        this.active = false;
      }
    }
  }
  receipt(runId: string) {
    this.authority.assertOriginalOwner();
    const receipt = this.receipts.get(runId);
    if (!receipt) throw new Error('Original-owner feature receipt unavailable');
    return structuredClone(receipt);
  }
}
