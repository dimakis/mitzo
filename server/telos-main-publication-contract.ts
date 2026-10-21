import { z } from 'zod';
import { TelosWorkIdSchema, AccountBindingSchema, type ValidAccountBinding } from '@mitzo/protocol';

export const githubCommit = z.string().regex(/^[a-f0-9]{40}$/);
export const normalPrPublicationContract = 'normal-pr-rules-v1' as const;
/** Native arguments contain intent and exact expected pins, never host authority. */
export const RequestGithubMainPublicationSchema = z.strictObject({
  requestId: TelosWorkIdSchema,
  itemId: TelosWorkIdSchema,
  pullRequest: z.number().int().positive().safe(),
  sourceHead: githubCommit,
  workRevision: z.string().min(1).max(200),
});
export type MainPublicationInput = z.infer<typeof RequestGithubMainPublicationSchema>;
export const MainPublicationAccountSchema = AccountBindingSchema.omit({ accountLabel: true });
/** IDs come from verified GitHub repository/PR responses, never native JSON.
 * Database IDs bind identity; retained node IDs bind direct lookup and the merge mutation. */
export const MainPublicationResourceSchema = z.strictObject({
  repositoryId: z.number().int().positive().safe(),
  repositoryNodeId: z.string().trim().min(1).max(200),
  pullRequestId: z.number().int().positive().safe(),
  pullRequestNodeId: z.string().trim().min(1).max(200),
});
export type MainPublicationResource = z.infer<typeof MainPublicationResourceSchema>;

/** Resolved by the signed ordinary host. None of these fields come from tool JSON. */
export interface MainPublicationAuthority {
  operatorId: string;
  conversationId: string;
  accountBinding: Pick<ValidAccountBinding, 'accountId' | 'provider' | 'model' | 'profileRevision'>;
  runtimeId: string;
  connectionId: string;
  capabilityId: string;
  repository: string;
  assignmentRevision: number;
  attemptId: string | null;
}
export interface MainPublicationPins {
  /** Optional only for unchanged historical exact-main receipts. Never admitted
   * under the new contract or offered new normal-rules permission. */
  contract?: typeof normalPrPublicationContract;
  input: MainPublicationInput & { mainHead?: string };
  authority: MainPublicationAuthority;
  resource: MainPublicationResource;
  baseBranch: 'main';
  method: 'squash';
}
export type MainPublicationInspection =
  | { state: 'ready'; evidenceRef: string; mainHead: string }
  | { state: 'accepted'; mergeCommit: string; mainHead: string; baseHead: string }
  | { state: 'conflicted'; observed: Extract<MainPublicationInspection, { state: 'accepted' }> }
  | { state: 'blocked' };

/** A distinct configured merge capability; branch/PR exporters do not implement it.
 * merge MUST perform a fresh remote inspection, then call admit synchronously
 * immediately before its single remote mutation (no intervening await). */
export interface GithubMainMergeCapability {
  readonly kind: 'github-main-merge';
  readonly connectionId: string;
  readonly capabilityId: string;
  readonly repository: string;
  /** Resolve actual configured repository/PR responses, never caller IDs.
   * Existing receipts recover retained identity, rather than freshly retagging it. */
  resolveResource(
    input: MainPublicationInput,
    signal: AbortSignal,
  ): Promise<MainPublicationResource>;
  inspect(pins: MainPublicationPins, signal: AbortSignal): Promise<MainPublicationInspection>;
  merge(
    pins: MainPublicationPins,
    signal: AbortSignal,
    admit: (inspection: Extract<MainPublicationInspection, { state: 'ready' }>) => void,
    acknowledge: (mergeCommit: string) => void,
  ): Promise<MainPublicationInspection>;
}
export interface MainPublicationReceipt {
  pins: MainPublicationPins;
  state: 'requested' | 'denied' | 'uncertain' | 'accepted' | 'conflicted';
  mergeCommit?: string;
  approvalReceiptId?: string;
  inspectedMainHead?: string;
  admittedMainHead?: string;
  remoteMergeCommit?: string;
  /** Derived from append-only acknowledgement facts; never replaces terminal custody. */
  acknowledgedMergeCommits?: string[];
  acceptedBaseHead?: string;
  acceptedMainHead?: string;
  verification?: 'acknowledged_squash' | 'observed_merged' | 'conflicting_evidence';
}
/** Public/native result excludes private signed operator, account, runtime,
 * capability and permission receipt custody retained in the host ledger. */
export type MainPublicationResult = MainPublicationInput & {
  state: MainPublicationReceipt['state'];
  acknowledgedMergeCommits?: string[];
  mergeCommit?: string;
  inspectedMainHead?: string;
  admittedMainHead?: string;
  acceptedBaseHead?: string;
  acceptedMainHead?: string;
  verification?: MainPublicationReceipt['verification'];
};
export function projectMainPublicationResult(
  receipt: MainPublicationReceipt,
): MainPublicationResult {
  return {
    requestId: receipt.pins.input.requestId,
    itemId: receipt.pins.input.itemId,
    pullRequest: receipt.pins.input.pullRequest,
    sourceHead: receipt.pins.input.sourceHead,
    workRevision: receipt.pins.input.workRevision,
    state: receipt.state,
    ...(receipt.acknowledgedMergeCommits
      ? { acknowledgedMergeCommits: [...receipt.acknowledgedMergeCommits] }
      : {}),
    ...(receipt.mergeCommit ? { mergeCommit: receipt.mergeCommit } : {}),
    ...(receipt.inspectedMainHead ? { inspectedMainHead: receipt.inspectedMainHead } : {}),
    ...(receipt.admittedMainHead ? { admittedMainHead: receipt.admittedMainHead } : {}),
    ...(receipt.acceptedBaseHead ? { acceptedBaseHead: receipt.acceptedBaseHead } : {}),
    ...(receipt.acceptedMainHead ? { acceptedMainHead: receipt.acceptedMainHead } : {}),
    ...(receipt.verification ? { verification: receipt.verification } : {}),
  };
}
