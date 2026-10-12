import { STAGING_NATIVE_FIXTURE_REVISION } from './symposium-staging-native-fixture.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AccountBinding } from '@mitzo/protocol';
import type { AccountProfiles } from './account-profiles.js';
import type { OwnedSymposiumGateway } from './symposium-owned-gateway.js';
import type { StagingNativeFeatureBootstrap } from './staging-native-feature-bootstrap.js';
import {
  StagingFeaturePlan,
  StagingFeatureRequest,
  StagingFeatureToken,
} from './staging-feature-owner.js';
import type { z } from 'zod';
import {
  captureQualifiedStagingNativeModelAuthority,
  type StagingNativeModelAuthority,
  type StagingNativeModelPlan,
  type StagingNativeModelRequestReceipt,
} from './staging-native-model-authority.js';
export interface StagingNativeEnrollment {
  readonly binding: AccountBinding;
  readonly selectedModel: string;
  readonly chargedAccount: string;
  readonly personalConnection?: { connectionId: string; expectedRevision: number };
  assertCurrent(): void;
}
type Plan = z.infer<typeof StagingFeaturePlan>;
type Token = z.infer<typeof StagingFeatureToken>;
const digest = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const runnerRevision = createHash('sha256')
  .update(readFileSync(new URL(import.meta.url)))
  .digest('hex');
const suiteRevision = digest({
  suite: 'profile-tools-v1',
  native: 1,
  seat: 'primary',
  role: 'reviewer',
  mainRounds: 2,
  fixtureRevision: STAGING_NATIVE_FIXTURE_REVISION,
});
/** Instantiated by the actual original custodian app composition. The real app
 * port owns fixture/grants/runtime/claims/events/physical retirement; no HTTP
 * command or caller-supplied successful result is accepted here. */
export class StagingNativeFeatureOwner {
  private readonly plans = new Map<
    string,
    {
      request: z.infer<typeof StagingFeatureRequest>;
      enrollment: StagingNativeEnrollment;
      modelAuthority: StagingNativeModelAuthority;
      modelPlan: StagingNativeModelPlan;
    }
  >();
  private readonly receipts = new Map<string, object>();
  private active = false;
  constructor(
    private readonly deps: {
      bootstrap: StagingNativeFeatureBootstrap;
      gateway: OwnedSymposiumGateway;
      ownerInstance: string;
      currentProfiles(): AccountProfiles;
      captureEnrollment(profileId: string, model: string): StagingNativeEnrollment;
      assertOriginalOwnerCurrent(): void;
      assertReservation(plan: Plan, token: Token, planSha256: string): void;
      execute(input: {
        plan: Plan;
        runId: string;
        enrollment: StagingNativeEnrollment;
        modelAuthority: StagingNativeModelAuthority;
        modelPlan: StagingNativeModelPlan;
        deadlineAt: number;
        assertCurrent(): void;
      }): Promise<{
        evidence: object;
        retirement: object;
        modelRequests: StagingNativeModelRequestReceipt;
      }>;
    },
  ) {}
  private current() {
    this.deps.bootstrap.assertOriginalOwnerCurrent();
    this.deps.assertOriginalOwnerCurrent();
    this.deps.gateway.verifyCustody();
    this.deps.bootstrap.observeResources();
  }
  resources() {
    this.current();
    return {
      version: 1,
      sourceCommit: this.deps.bootstrap.sourceCommit,
      ownerInstance: this.deps.ownerInstance,
      resources: this.deps.bootstrap.observeResources(),
    };
  }
  private capture(profileId: string) {
    this.current();
    const catalog = this.deps
      .currentProfiles()
      .catalog()
      .find((entry) => entry.id === profileId);
    if (!catalog || catalog.modelDiscovery.stale)
      throw Error('Fresh original profile/model catalog unavailable');
    const luna = catalog.models.find((model) => /^gpt-\d+(?:\.\d+)?-luna$/.test(model.id));
    // A fixed single Vertex model can be displayed for exact exception review.
    // Only the actual native model authority may supply an authenticated approval.
    const selected =
      luna ??
      (catalog.provider === 'anthropic-vertex' && catalog.models.length === 1
        ? catalog.models[0]
        : undefined);
    if (!selected) throw Error('Explicit supported Luna or approved exact alternative required');
    const enrollment = this.deps.captureEnrollment(profileId, selected.id);
    enrollment.assertCurrent();
    const enrollmentRevision = digest({
      sourceCommit: this.deps.bootstrap.sourceCommit,
      ownerInstance: this.deps.ownerInstance,
      binding: enrollment.binding,
      chargedAccount: enrollment.chargedAccount,
      selectedModel: enrollment.selectedModel,
    });
    return { enrollment, enrollmentRevision };
  }
  enrollment(profileId: string) {
    const current = this.capture(profileId);
    return { profileId, enrollmentRevision: current.enrollmentRevision };
  }
  plan(raw: unknown, sourceCommit: string) {
    const request = StagingFeatureRequest.parse(raw);
    const current = this.capture(request.profileId);
    if (
      sourceCommit !== this.deps.bootstrap.sourceCommit ||
      request.acceptedCommit !== sourceCommit ||
      request.enrollmentRevision !== current.enrollmentRevision ||
      this.plans.size >= 100
    )
      throw Error('Exact original native feature source/enrollment required');
    const authority = captureQualifiedStagingNativeModelAuthority(this.deps.gateway);
    const modelPlan = authority.plan({
      binding: current.enrollment.binding,
      selectedModel: current.enrollment.selectedModel,
      maxRequests: 2,
      auxiliaryDispatches: 'disabled',
    });
    modelPlan.assertCurrent();
    if (modelPlan.selectedModel !== current.enrollment.selectedModel)
      throw Error('Authenticated native model selection differs from the explicit enrolled model');
    if (
      !/^gpt-\d+(?:\.\d+)?-luna$/.test(current.enrollment.selectedModel) &&
      !modelPlan.modelApprovalId
    )
      throw Error('Original authenticated exact non-Luna approval required');
    const plan = StagingFeaturePlan.parse({
      version: 1,
      requestId: request.id,
      sourceCommit,
      profileId: request.profileId,
      enrollmentRevision: current.enrollmentRevision,
      profileRevision: current.enrollment.binding.profileRevision,
      provider: current.enrollment.binding.provider,
      runtime: 'openshell-native',
      runtimeRevision: modelPlan.revision,
      ownerInstance: this.deps.ownerInstance,
      chargedAccount: modelPlan.chargedAccount,
      selectedModel: current.enrollment.selectedModel,
      modelApprovalId: modelPlan.modelApprovalId,
      suite: request.suite,
      suiteRevision,
      runnerRevision,
      modelDispatches: [
        {
          purpose: 'main',
          chargedAccount: modelPlan.chargedAccount,
          selectedModel: current.enrollment.selectedModel,
          maxModelRounds: 2,
        },
      ],
      auxiliaryDispatches: 'disabled',
      limits: { maxProviderDispatches: 1, timeoutMs: 180000, maxOutputBytes: 65536 },
    });
    const planSha256 = digest(plan);
    this.plans.set(planSha256, {
      request,
      enrollment: current.enrollment,
      modelAuthority: authority,
      modelPlan,
    });
    return { plan, planSha256 };
  }
  async run(raw: unknown, rawToken: unknown, assertRequestCurrent?: () => void) {
    if (!assertRequestCurrent)
      throw Error('Original authenticated custodian request authority required');
    assertRequestCurrent();
    const plan = StagingFeaturePlan.parse(raw),
      token = StagingFeatureToken.parse(rawToken),
      planSha256 = digest(plan);
    const original = this.plans.get(planSha256);
    if (!original || this.active || token.requestId !== plan.requestId)
      throw Error('Original announced native feature plan required');
    const current = this.plan(original.request, plan.sourceCommit);
    if (current.planSha256 !== planSha256) throw Error('Original native feature plan changed');
    const deadlineAt = Date.now() + plan.limits.timeoutMs;
    const assertCurrent = () => {
      if (Date.now() >= deadlineAt) throw Error('Original native feature deadline expired');
      assertRequestCurrent();
      this.current();
      original.enrollment.assertCurrent();
      original.modelPlan.assertCurrent();
      this.deps.assertReservation(plan, token, planSha256);
    };
    assertCurrent();
    this.active = true;
    const runId = randomUUID();
    // Failure retains the original active runner and all cleanup capabilities.
    // A timeout/rejection is never permission to start another runner.
    const actual = await this.deps.execute({ plan, runId, ...original, deadlineAt, assertCurrent });
    assertCurrent();
    const charged = actual.modelRequests;
    if (
      charged.chargedAccount !== plan.chargedAccount ||
      charged.selectedModel !== plan.selectedModel ||
      ![1, 2].includes(charged.requestCount) ||
      charged.policyRevision !== plan.runtimeRevision ||
      !/^[a-f0-9]{64}$/.test(charged.requestsSha256) ||
      !Number.isFinite(charged.revokedAt)
    )
      throw Error('Actual native HTTP model/account/request retirement receipt differs');
    const ownerReceipt = {
      version: 1,
      runId,
      sourceCommit: plan.sourceCommit,
      ownerInstance: plan.ownerInstance,
      profileId: plan.profileId,
      enrollmentRevision: plan.enrollmentRevision,
      planSha256,
      ...actual,
    };
    this.receipts.set(runId, Object.freeze(ownerReceipt));
    this.active = false;
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
        ownerReceiptSha256: digest(ownerReceipt),
      },
    };
  }
  receipt(runId: string) {
    this.current();
    const receipt = this.receipts.get(runId);
    if (!receipt) throw Error('Original native owner receipt unavailable');
    return { receipt, ownerReceiptSha256: digest(receipt) };
  }
}
