import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  COLLABORATION_EXECUTION_DISABLED,
  type CollaborationJoin,
  type CollaborationJoinInput,
} from '@mitzo/protocol';
import {
  ConversationJoiningReview,
  ConversationJoiningReviewActions,
} from '../../frontend/src/components/ConversationJoiningReview';
import { HomeDialog } from '../../frontend/src/components/HomeDialog';
import { useConversationJoiningReview } from '../../frontend/src/hooks/useConversationJoiningReview';
import {
  joiningReviewFixture,
  joiningSetupFixture,
} from '../../frontend/src/preview/conversation-joining-fixture';
import type { ConversationJoiningOwner } from '../../frontend/src/lib/conversation-joining-review';
import { createBrowserId, sha256Hex } from '../../frontend/src/lib/browser-crypto';
import { restoreCookieAuthentication } from '../../frontend/src/lib/api-fetch';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/motion.css';
import '../../frontend/src/components/ConversationAgents.css';

// Joining uses synthetic callbacks; the real auth owner reads an intercepted
// fixture login identity. No account, backend store, runtime or provider is invoked.
const mode = new URLSearchParams(location.search).get('state');
const calls = {
  reviews: 0,
  confirmations: [] as CollaborationJoinInput[],
  recoveries: [] as string[],
};
Object.assign(window, { joiningFixture: calls });
let known: CollaborationJoin | null = null;
const owner: ConversationJoiningOwner = {
  sourceConversationId: 'source-chat',
  async review({ joiningBrief }) {
    calls.reviews++;
    if (mode === 'review-error') throw new Error('Synthetic offline refusal');
    if (mode === 'refreeze-error' && joiningBrief !== undefined)
      throw new Error('Synthetic offline refusal');
    const snapshot = joiningReviewFixture(
      joiningBrief === undefined
        ? {}
        : {
            joiningBrief,
            snapshotId: createBrowserId(),
            sha256: sha256Hex(joiningBrief),
          },
    );
    if (mode === 'capacity')
      snapshot.snapshot.capacity = {
        status: 'needs_reviewed_summary',
        reason: 'Choose less context before joining.',
      };
    return snapshot;
  },
  async confirm(input) {
    calls.confirmations.push(structuredClone(input));
    if (mode === 'uncertain' && calls.confirmations.length === 1)
      throw new Error('Synthetic lost acknowledgement');
    known ??= {
      version: 1,
      joinId: '00000000-0000-4000-8000-000000000010',
      name: input.name,
      membershipRevision: input.expectedMembershipRevision,
      settings: input.settings,
      snapshot: input.snapshot,
      allocationOperationId: '00000000-0000-4000-8000-000000000011',
      state: 'pending_preparation',
      sessionId: null,
      linkedFromRevision: null,
      execution: COLLABORATION_EXECUTION_DISABLED,
    };
    return structuredClone(known);
  },
  async recover(joinId) {
    calls.recoveries.push(joinId);
    if (!known || known.joinId !== joinId) throw new Error('Missing synthetic receipt');
    known = { ...known, state: 'linked', sessionId: 'offline-fresh-chat', linkedFromRevision: 1 };
    return structuredClone(known);
  },
};
function Fixture() {
  const [open, setOpen] = useState(false);
  const flow = useConversationJoiningReview(owner);
  const close = () => setOpen(false);
  return (
    <>
      <div data-fixture-controls>
        <button
          type="button"
          onClick={(event) => {
            event.currentTarget.focus();
            setOpen(true);
            if (!flow.review && !flow.locked) void flow.prepare(joiningSetupFixture());
          }}
        >
          Review joining brief
        </button>
      </div>
      {open && (
        <HomeDialog
          title="Before joining"
          className="conversation-agents-dialog conversation-joining-dialog"
          closeLabel="Close Agents"
          onClose={close}
          onBack={close}
          backLabel="Back from joining review"
        >
          <div className="conversation-agents-body">
            <ConversationJoiningReview
              flow={flow}
              agents={[
                {
                  id: 'source-chat',
                  name: 'Mitzo',
                  state: 'Current conversation',
                  policy: { reads: true, replies: true },
                },
              ]}
              onAgents={close}
            />
          </div>
          <ConversationJoiningReviewActions flow={flow} onBack={close} />
        </HomeDialog>
      )}
    </>
  );
}
void restoreCookieAuthentication().then((authenticated) => {
  if (!authenticated) throw new Error('Offline fixture authentication unavailable');
  createRoot(document.getElementById('root')!).render(<Fixture />);
});
