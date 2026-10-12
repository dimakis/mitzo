import type { AccountBinding } from '@mitzo/protocol';
import type { OwnedSymposiumGateway } from './symposium-owned-gateway.js';
/** Interface for the separately qualified native in-process outbound policy.
 * No implementation, setter, request flag or persisted JSON grants authority.
 * The original gateway must mint this after its exact source/build is verified. */
export interface StagingNativeModelPlan {
  readonly revision: string;
  readonly modelApprovalId: string | null;
  assertCurrent(): void;
}
export interface StagingNativeModelRequestReceipt {
  readonly version: 1;
  readonly chargedAccount: string;
  readonly selectedModel: string;
  readonly claimToken: string;
  readonly sandboxId: string;
  readonly requestCount: 1 | 2;
  readonly requestsSha256: string;
  readonly policyRevision: string;
  readonly revokedAt: number;
}
export interface StagingNativeModelAuthority {
  plan(input: {
    binding: AccountBinding;
    chargedAccount: string;
    selectedModel: string;
    maxRequests: 2;
    auxiliaryDispatches: 'disabled';
  }): StagingNativeModelPlan;
  issue(
    plan: StagingNativeModelPlan,
    input: {
      sessionId: string;
      seatId: 'primary';
      claimToken: string;
      sandboxName: string;
      sandboxId: string;
      deadlineAt: number;
    },
  ): Promise<{
    assertCurrent(): void;
    revokeAndConfirm(): Promise<StagingNativeModelRequestReceipt>;
  }>;
}
/** Installed upstream854b/native9472 routing has no account/model/body predicate
 * or original per-run request counter. Refuse before fixture creation or native
 * launch until the actual gateway source bridge is independently qualified. */
export function captureQualifiedStagingNativeModelAuthority(
  _gateway: OwnedSymposiumGateway,
): StagingNativeModelAuthority {
  throw Error(
    'Original gateway HTTP account/model/auxiliary/max-two-request enforcement is not qualified',
  );
}
