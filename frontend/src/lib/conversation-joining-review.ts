import type {
  AgentProfileSelection,
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
export interface ConversationJoiningOwner {
  sourceConversationId: string;
  artifacts?: ConversationArtifactOption[];
  review(
    input: {
      requestId: string;
      setup: ConversationAgentSetup;
      joiningBrief?: string;
      previousSnapshot?: { snapshotId: string; sha256: string };
    },
    signal: AbortSignal,
  ): Promise<ConversationJoiningReviewResult>;
  confirm(input: CollaborationJoinInput): Promise<CollaborationJoin>;
  recover(joinId: string, signal: AbortSignal): Promise<CollaborationJoin>;
}
