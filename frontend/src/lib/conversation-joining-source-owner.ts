import type { MitzoApiClient } from '@mitzo/client';
import {
  CollaborationSourceSetupQuerySchema,
  type CollaborationSourceSetup,
} from '@mitzo/protocol';
import { AUTH_LOST_EVENT, AUTH_RESTORED_EVENT } from './api-fetch';
import { createBrowserId } from './browser-crypto';
import { conversationJoiningRecovery, joiningReviewEqual } from './conversation-joining-recovery';

/** Invoke only for an explicit Add/setup action. This creates a relationship,
 * never an agent session, prepared workspace, capacity receipt or model turn.
 * A returned selected result is a current canonical read, not persisted authority.
 */
export async function resolveConversationJoiningSource(options: {
  api: MitzoApiClient;
  sourceConversationId: string;
  getClientId(): string | null | undefined;
  isCurrent(): boolean;
  signal: AbortSignal;
}): Promise<CollaborationSourceSetup> {
  const { api, sourceConversationId, signal } = options;
  const query = CollaborationSourceSetupQuerySchema.parse({
    sourceConversationId,
    clientId: options.getClientId(),
  });
  const journal = conversationJoiningRecovery(sourceConversationId);
  let invalidated = false;
  const invalidate = () => {
    invalidated = true;
  };
  window.addEventListener(AUTH_LOST_EVENT, invalidate);
  window.addEventListener(AUTH_RESTORED_EVENT, invalidate);
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (
      invalidated ||
      !journal.isCurrent() ||
      !options.isCurrent() ||
      options.getClientId() !== query.clientId
    )
      throw new Error('Fresh agent setup changed. The original request stays retained.');
  };
  try {
    assertCurrent();
    let retained = journal.readBegin();
    const read = async () => {
      assertCurrent();
      const result = await api.collaborations.sourceSetup(
        sourceConversationId,
        query.clientId,
        signal,
      );
      assertCurrent();
      if (!joiningReviewEqual(journal.readBegin(), retained))
        throw new Error('The original fresh agent setup changed during the check.');
      if (
        result.state === 'selected' &&
        retained &&
        result.collaboration.collaborationId !== retained.collaborationId
      )
        throw new Error('The original fresh agent setup must be recovered.');
      return result;
    };
    const source = await read();
    if (source.state !== 'unstarted') return source;
    if (!retained) {
      if (journal.read()) throw new Error('The original joining review must be recovered.');
      retained = journal.retainBegin(
        { collaborationId: createBrowserId(), requestId: createBrowserId() },
        null,
      );
    }
    assertCurrent();
    await api.collaborations.begin(
      retained.collaborationId,
      {
        requestId: retained.requestId,
        sessionId: sourceConversationId,
      },
      signal,
    );
    assertCurrent();
    const selected = await read();
    if (selected.state === 'unstarted')
      throw new Error('Fresh agent setup could not be verified. Check the original request again.');
    return selected;
  } finally {
    window.removeEventListener(AUTH_LOST_EVENT, invalidate);
    window.removeEventListener(AUTH_RESTORED_EVENT, invalidate);
  }
}
