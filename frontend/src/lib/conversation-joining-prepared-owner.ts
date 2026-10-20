import type { ApplicationConversationJoiningOwner } from './conversation-joining-review';
import { createConversationJoiningApplicationOwner } from './conversation-joining-application-owner';
import { prepareConversationJoiningTarget } from './conversation-joining-target-owner';
import { ConversationJoiningTargetError } from './conversation-joining-target-intent';
import { conversationJoiningRecovery } from './conversation-joining-recovery';
import { consumeChatDraft } from './chat-drafts';

/** Composition over existing ordinary preparation and observational review.
 * The application supplies the genuine monotonic route/action/auth fence. */
export function createPreparedConversationJoiningOwner(
  options: Parameters<typeof createConversationJoiningApplicationOwner>[0] & {
    getRepository(): string | null;
    isCurrent(): boolean;
    onLinked?(): void;
  },
): ApplicationConversationJoiningOwner {
  const child = createConversationJoiningApplicationOwner(options);
  const sourceRepository = options.getRepository() ?? undefined;
  const journal = conversationJoiningRecovery(options.sourceConversationId);
  let prepared: {
    requestId: string;
    repositoryWorkspaceId: string;
    permissionMode: 'ask' | 'agent' | 'auto';
  } | null = null;
  const assertCurrent = (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (!options.isCurrent() || !journal.isCurrent())
      throw new ConversationJoiningTargetError(
        'Fresh-agent setup changed. The original request stays retained.',
      );
  };
  return {
    ...child,
    sourceRepository,
    async prepareReview(input, signal) {
      assertCurrent(signal);
      const request = structuredClone(input);
      const target = await prepareConversationJoiningTarget({
        sourceConversationId: options.sourceConversationId,
        collaborationId: options.collaborationId,
        repository: options.getRepository(),
        request,
        signal,
        isCurrent: options.isCurrent,
      });
      assertCurrent(signal);
      prepared = { requestId: request.requestId, ...target };
    },
    async captureReview(input, signal) {
      assertCurrent(signal);
      const retained = journal.readTarget();
      if (
        !prepared ||
        prepared.requestId !== input.requestId ||
        !retained ||
        retained.phase !== 'resolved' ||
        retained.preview.requestId !== prepared.repositoryWorkspaceId ||
        retained.draft.settings.mode !== prepared.permissionMode ||
        retained.preview.repository !== options.getRepository()
      )
        throw new ConversationJoiningTargetError(
          'Check the original target before reviewing this joining brief.',
        );
      const result = await child.captureReview(
        {
          ...structuredClone(input),
          setup: {
            ...structuredClone(input.setup),
            repositoryWorkspaceId: prepared.repositoryWorkspaceId,
            permissionMode: prepared.permissionMode,
          },
        },
        signal,
      );
      assertCurrent(signal);
      return result;
    },
    async review(input, signal) {
      assertCurrent(signal);
      const retained = journal.readTarget();
      if (retained && retained.preview.repository !== options.getRepository())
        throw new ConversationJoiningTargetError(
          'The repository changed. Return to setup and review it again.',
        );
      const result = await child.review(input, signal);
      assertCurrent(signal);
      return result;
    },
    async confirm(input) {
      assertCurrent();
      const result = await child.confirm(input);
      assertCurrent();
      return result;
    },
    async recover(id, signal) {
      assertCurrent(signal);
      const result = await child.recover(id, signal);
      assertCurrent(signal);
      return result;
    },
    onLinked(join) {
      assertCurrent();
      const target = journal.readTarget();
      if (
        join.state === 'linked' &&
        target?.collaborationId === options.collaborationId &&
        target.preview.requestId === join.settings.repositoryWorkspaceId
      )
        consumeChatDraft(target.draft);
      options.onLinked?.();
    },
  };
}
