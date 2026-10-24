import type { EventStore } from './event-store.js';
import type { NativeHostToolContext } from './native-host-tool-context.js';
import type { HistoryAccess } from './session-history-tools.js';
import type { ProfileToolCall } from './session-profile-tools.js';

/** Called only by the original verified owned-local native callback. The raw
 * native context already binds middleware-authenticated operator, exact runtime,
 * workspace, account, mode, selected tool, skill ceiling and pending native call.
 * Naming a target here never creates an account/workspace/session grant. */
export function captureSessionHistoryAuthorization(owners: {
  context: NativeHostToolContext;
  events: Pick<EventStore, 'getSession' | 'captureReconnectState'>;
  call: ProfileToolCall;
  toolName: 'SearchPastSessions' | 'ReadPastSession';
}): HistoryAccess {
  const { context, events } = owners;
  const targets = new Map<string, { assertCurrent(): void }>();
  const assertCurrent = () => {
    context.signal.throwIfAborted();
    context.assertCurrentSync();
    if (
      context.toolName !== owners.toolName ||
      context.turnId !== owners.call.turnId ||
      context.callId !== owners.call.callId
    )
      throw Error('Original history tool call unavailable');
  };
  const assertCurrentAsync = async () => {
    assertCurrent();
    await context.assertCurrent();
    assertCurrent();
  };
  assertCurrent();
  return {
    signal: context.signal,
    assertCurrent,
    assertCurrentAsync,
    async authorizeSearch() {
      if (owners.toolName !== 'SearchPastSessions') throw Error('History search unavailable');
      await assertCurrentAsync();
    },
    async authorizeRead(conversationId) {
      await assertCurrentAsync();
      // Match the existing signed-operator product policy: only registered
      // visible conversations, never SDK artifacts or filesystem transcripts.
      const original = events.getSession(conversationId);
      if (!original || original.isHidden) throw Error('History target unavailable');
      const target = {
        assertCurrent() {
          assertCurrent();
          const current = events.getSession(conversationId);
          if (
            !current ||
            current.isHidden ||
            current.createdAt !== original.createdAt ||
            current.conversationSource !== original.conversationSource
          )
            throw Error('History target unavailable');
        },
      };
      targets.set(conversationId, target);
      target.assertCurrent();
      return target;
    },
    readBoundary(conversationId) {
      assertCurrent();
      const target = targets.get(conversationId);
      if (!target) throw Error('Authorized history target required');
      target.assertCurrent();
      const boundary = events.captureReconnectState(conversationId, 0, false).cursor;
      target.assertCurrent();
      return boundary;
    },
    dispose() {
      context.dispose();
    },
  };
}
