import type {
  AgentProfileSelection,
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
}
export interface ConversationArtifactOption {
  artifactId: string;
  revision: number;
  sha256: string;
  title: string;
  filename?: string;
}
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
}
interface JoiningOwnerBase {
  sourceConversationId: string;
  artifacts?: ConversationArtifactOption[];
  confirm(input: CollaborationJoinInput): Promise<CollaborationJoin>;
  recover(joinId: string, signal: AbortSignal): Promise<CollaborationJoin>;
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
