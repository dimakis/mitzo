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
  const captureTarget = (conversationId: string) => {
    const original = events.getSession(conversationId);
    if (!original || original.isHidden) return null;
    const { createdAt, conversationSource } = original;
    const assertIdentity = () => {
      const current = events.getSession(conversationId);
      if (
        !current ||
        current.isHidden ||
        current.createdAt !== createdAt ||
        current.conversationSource !== conversationSource
      )
        throw Error('History target unavailable');
    };
    const target = {
      assertCurrent() {
        assertCurrent();
        assertIdentity();
      },
    };
    return { target, assertIdentity };
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
      const captured = captureTarget(conversationId);
      if (!captured) throw Error('History target unavailable');
      const { target } = captured;
      targets.set(conversationId, target);
      target.assertCurrent();
      return target;
    },
    async authorizeSearchPage(conversationIds, signal) {
      signal.throwIfAborted();
      if (
        owners.toolName !== 'SearchPastSessions' ||
        conversationIds.length > 100 ||
        conversationIds.some((id) => typeof id !== 'string' || !id.trim() || id.length > 128)
      )
        throw Error('History search page unavailable');
      await assertCurrentAsync();
      signal.throwIfAborted();
      // These SQL identity reads are synchronous and publish no data. Repeating
      // the entire native owner per row multiplies filesystem, credential and
      // workspace checks. The exact owner is refreshed on both sides of this
      // bounded batch; every target is physically re-read after the final await.
      const captured = conversationIds.map(captureTarget);
      await assertCurrentAsync();
      signal.throwIfAborted();
      for (const entry of captured) entry?.assertIdentity();
      assertCurrent();
      return captured.map((entry) => entry?.target ?? null);
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
