import type { useConversationDiscussion } from '../hooks/useConversationDiscussion';

/** Existing flat Agents policy feedback. A refresh is observational and policy
 * changes do not ask any agent to respond. No delivery controls live here. */
export function ConversationDiscussionFeedback({
  discussion,
}: {
  discussion: ReturnType<typeof useConversationDiscussion>;
}) {
  if (!discussion.requested) return null;
  const state = discussion.presentation;
  return (
    <>
      {state.loading && <p role="status">Checking discussion sharing…</p>}
      {state.error && <p role="alert">{state.error}</p>}
      {state.policyError && <p role="alert">{state.policyError}</p>}
      {state.pendingPolicy?.uncertain && (
        <p role="status">
          The sharing change is uncertain. Check the original request before changing it again.
        </p>
      )}
      {discussion.recipientReason && <p role="status">{discussion.recipientReason}</p>}
      <button
        type="button"
        className="home-secondary"
        disabled={state.loading}
        onClick={() =>
          void (state.pendingPolicy?.uncertain ? state.retryPolicy() : state.refresh())
        }
      >
        {state.pendingPolicy?.uncertain ? 'Check sharing request' : 'Refresh discussion sharing'}
      </button>
    </>
  );
}
