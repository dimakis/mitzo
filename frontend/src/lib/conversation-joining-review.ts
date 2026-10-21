import type {
  AgentProfileSelection,
  CollaborationApplicationReviewResult,
  CollaborationApplicationReviewInput,
  CollaborationJoin,
  CollaborationJoinInput,
  CollaborationSettings,
  CollaborationSnapshot,
  CollaborationSnapshotSelection,
} from '@mitzo/protocol';
import type { AccountSelection } from '../types/account-selection';

/** Editable intent only. Catalog labels never become an admitted runtime binding. */
export interface ConversationAgentSetup {
  name: string;
  purpose: string;
  context: 'conversation_so_far' | 'selected';
  messageIds: string[];
  artifacts: CollaborationSnapshotSelection['artifacts'];
  runOn: 'openshell' | 'local';
  selection: AccountSelection | null;
  agent: AgentProfileSelection | null;
  /** Exact read-only repository intent reviewed in the current source catalog. */
  sourceRepository?: string;
  /** Explicit fresh-target intent only; the server revalidates preparation custody. */
  repositoryWorkspaceId?: string;
  permissionMode?: CollaborationApplicationReviewInput['target']['permissionMode'];
}
export type ConversationArtifactOption = NonNullable<
  CollaborationApplicationReviewResult['artifactLabels']
>[number];
export interface ConversationJoiningReviewResult {
  snapshot: CollaborationSnapshot;
  settings: CollaborationSettings;
  expectedMembershipRevision: number;
  artifactLabels?: ConversationArtifactOption[];
}
/** Installed explicitly by the authenticated source/ordinary preparation owner.
 * No production owner is installed by this presentation slice. Review has no
 * allocation/model side effects. Confirm/recover retain ordinary operation IDs.
 */
export interface ConversationJoiningReviewRequest {
  requestId: string;
  setup: ConversationAgentSetup;
  joiningBrief?: string;
  previousSnapshot?: { snapshotId: string; sha256: string };
  /** Retained public source selectors for a brief-only refreeze, never source bytes or access proof. */
  previousSource?: Pick<
    CollaborationApplicationReviewInput['selection'],
    'boundary' | 'expectedMembershipRevision'
  >;
}
interface JoiningOwnerBase {
  sourceConversationId: string;
  artifacts?: ConversationArtifactOption[];
  confirm(input: CollaborationJoinInput): Promise<CollaborationJoin>;
  recover(joinId: string, signal: AbortSignal): Promise<CollaborationJoin>;
  /** Ordinary draft consumption only after the hook verifies a linked receipt. */
  onLinked?(join: CollaborationJoin): void;
}
export interface LegacyConversationJoiningOwner extends JoiningOwnerBase {
  kind?: undefined;
  review(
    input: ConversationJoiningReviewRequest,
    signal: AbortSignal,
  ): Promise<ConversationJoiningReviewResult>;
}
/** Capture is observational. The hook durably retains its parsed public intent
 * before review crosses the authenticated POST boundary. Live client identity
 * and all server-owned capacity/preparation evidence stay outside this contract. */
export interface ApplicationConversationJoiningOwner extends JoiningOwnerBase {
  kind: 'application';
  collaborationId: string;
  sourceRepository?: string;
  /** Optional existing ordinary target staging, invoked only by an explicit
   * review intent after its request is retained. Capture itself stays observational. */
  prepareReview?(input: ConversationJoiningReviewRequest, signal: AbortSignal): Promise<void>;
  captureReview(
    input: ConversationJoiningReviewRequest,
    signal: AbortSignal,
  ): Promise<CollaborationApplicationReviewInput>;
  review(
    input: CollaborationApplicationReviewInput,
    signal: AbortSignal,
  ): Promise<ConversationJoiningReviewResult>;
}
export type ConversationJoiningOwner =
  LegacyConversationJoiningOwner | ApplicationConversationJoiningOwner;
