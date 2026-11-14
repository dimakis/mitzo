import type { EventStore } from './event-store.js';
import type { ManagedSession } from '@mitzo/harness';
import type { HistoryAccess } from './session-history-tools.js';
import type { ProfileToolCall } from './session-profile-tools.js';
import { agentToolAllowed } from './agent-tool-selection.js';

/** Minimal caller facet supplied by the verified native or SDK adapter. */
export interface SessionHistoryCaller {
  readonly session?: ManagedSession;
  readonly signal: AbortSignal;
  readonly toolName: string;
  readonly turnId: string;
  readonly callId: string;
  assertCurrentSync(): void;
  assertCurrent(): Promise<void>;
  dispose(): void;
}

/** Called only by the original verified callback. Its context already binds
 * authenticated operator, exact runtime, account, selected tool and skill ceiling.
 * Naming a target here never creates an account/workspace/session grant. */
export function captureSessionHistoryAuthorization(owners: {
  context: SessionHistoryCaller;
  events: Pick<EventStore, 'getSession' | 'captureReconnectState'>;
  call: ProfileToolCall;
  toolName: 'SearchPastSessions' | 'ReadPastSession';
  /** Native names are unprefixed; SDK skills use the exact MCP wire name. */
  permissionPrefix?: string;
}): HistoryAccess {
  const { context, events } = owners;
  const targets = new Map<string, { assertIdentity(): void }>();
  let transcriptSearch = false;
  const transcriptReadAllowed = () => {
    const session = context.session;
    return (
      !!session &&
      agentToolAllowed(session, 'ReadPastSession') &&
      (!session.activeSkillPolicy ||
        session.activeSkillPolicy.has((owners.permissionPrefix ?? '') + 'ReadPastSession'))
    );
  };
  const assertCurrent = () => {
    context.signal.throwIfAborted();
    context.assertCurrentSync();
    if (
      context.toolName !== owners.toolName ||
      context.turnId !== owners.call.turnId ||
      context.callId !== owners.call.callId ||
      (transcriptSearch && !transcriptReadAllowed())
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
        // The adapter refreshes the shared owner before checking this bounded
        // target set. Each target only refreshes its own identity/visibility;
        // repeating the full native policy here multiplies host I/O per row.
        assertIdentity();
      },
    };
    return { target, assertIdentity };
  };
  assertCurrent();
  return {
    conversationId: context.session?.sessionId,
    signal: context.signal,
    assertCurrent,
    assertCurrentAsync,
    allowTranscriptSearch() {
      assertCurrent();
      const allowed = owners.toolName === 'SearchPastSessions' && transcriptReadAllowed();
      transcriptSearch ||= allowed;
      return allowed;
    },
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
      targets.set(conversationId, captured);
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
      return captured.map((entry, index) => {
        if (entry) targets.set(conversationIds[index], entry);
        return entry?.target ?? null;
      });
    },
    readBoundary(conversationId) {
      assertCurrent();
      if (owners.toolName === 'SearchPastSessions' && !transcriptSearch)
        throw Error('Companion transcript read capability required');
      const target = targets.get(conversationId);
      if (!target) throw Error('Authorized history target required');
      target.assertIdentity();
      const boundary = events.captureReconnectState(conversationId, 0, false).cursor;
      target.assertIdentity();
      return boundary;
    },
    dispose() {
      context.dispose();
    },
  };
}
