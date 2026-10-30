import { isDeepStrictEqual } from 'node:util';
import {
  interruptUnansweredToolBlocks,
  parseContentBlocks,
  SourceSnapshotsSchema,
  SymposiumProvenanceSchema,
  type SourceSnapshot,
  type SymposiumProvenance,
  type StoredEvent,
} from '@mitzo/protocol';
import {
  recordAcceptedReplaySession,
  replayError,
  type AcceptedReplaySessions,
} from './public-replay-error.js';

// Pure projection of a caller-owned immutable event prefix. Source authorization,
// cursor capture and database reads remain with the calling operation.
export interface RestoredMessage {
  messageId: string;
  symposiumProvenance?: SymposiumProvenance;
  role: string;
  timestamp?: number;
  startedSeq?: number;
  /** Exact retained completion anchor; absent for interrupted/synthetic history. */
  completedSeq?: number;
  images?: string[];
  contextBlocks?: string[];
  sourceSnapshots?: SourceSnapshot[];
  blocks: Array<{
    blockId: string;
    blockType: string;
    content: string;
    toolName?: string;
    toolId?: string;
    toolInput?: string;
    rawInput?: unknown;
    toolResult?: string;
    toolResultImages?: Array<{ id: string; mediaType: string }>;
    toolError?: boolean;
    toolInterrupted?: boolean;
    subagent?: RestoredSubagentState;
  }>;
}

export interface RestoredSubagentState {
  messageId: string;
  blocks: Array<RestoredMessage['blocks'][number] & { done?: boolean }>;
  running?: true;
  summary?: string;
  usage?: Record<string, number>;
}

export interface RestoredCurrentMessage {
  messageId: string;
  symposiumProvenance?: SymposiumProvenance;
  startedSeq?: number;
  blocks: Array<RestoredMessage['blocks'][number] & { done: boolean }>;
}

/** Finished messages are append-only during replay. Results/subagents have
 * already been resolved from this exact event prefix, so a terminal boundary
 * only needs to visit messages appended since the previous boundary. Error
 * regrouping happens after replay and must not run while this cursor is active. */
function terminalProjection(messages: RestoredMessage[]): () => void {
  let through = 0;
  return () => {
    for (; through < messages.length; through++) {
      const message = messages[through];
      const blocks = interruptUnansweredToolBlocks(message.blocks);
      if (blocks !== message.blocks) messages[through] = { ...message, blocks };
    }
  };
}

/** Scope reused block IDs to the assistant turn that opened the parent tool. */
function replaySubagents(events: StoredEvent[]) {
  type NestedBlock = RestoredMessage['blocks'][number] & { done: boolean };
  const key = (messageId: string, blockId: string) => JSON.stringify([messageId, blockId]);
  const parentMessageByBlock = new Map<string, string>();
  const activeStateByParent = new Map<string, string>();
  const states = new Map<
    string,
    {
      messageId: string;
      blocks: Map<string, NestedBlock>;
      order: string[];
      running: boolean;
      summary?: string;
      usage?: Record<string, number>;
    }
  >();
  for (const event of events) {
    const p = event.payload;
    if (
      event.type === 'block_start' &&
      typeof p.blockId === 'string' &&
      typeof p.messageId === 'string'
    ) {
      parentMessageByBlock.set(p.blockId, p.messageId);
      activeStateByParent.delete(p.blockId);
    }
    const parentId = p.parentBlockId as string;
    if (event.type === 'subagent_start' && typeof p.subagentMessageId === 'string') {
      const parentMessageId = parentMessageByBlock.get(parentId);
      if (!parentMessageId) continue;
      const scope = key(parentMessageId, parentId);
      activeStateByParent.set(parentId, scope);
      states.set(scope, {
        messageId: p.subagentMessageId,
        blocks: new Map(),
        order: [],
        running: true,
      });
      continue;
    }
    const state = states.get(activeStateByParent.get(parentId) ?? '');
    if (!state) continue;
    if (event.type === 'subagent_block_start' && typeof p.blockId === 'string') {
      state.blocks.set(p.blockId, {
        blockId: p.blockId,
        blockType: p.blockType as string,
        content: '',
        done: false,
        ...(typeof p.toolName === 'string' ? { toolName: p.toolName } : {}),
      });
      if (!state.order.includes(p.blockId)) state.order.push(p.blockId);
    } else if (event.type === 'subagent_block_delta') {
      const block = state.blocks.get(p.blockId as string);
      if (block && typeof p.delta === 'string') block.content += p.delta;
    } else if (event.type === 'subagent_block_end') {
      const block = state.blocks.get(p.blockId as string);
      if (!block) continue;
      block.done = true;
      if (typeof p.toolName === 'string') block.toolName = p.toolName;
      if (typeof p.toolId === 'string') block.toolId = p.toolId;
      if (typeof p.input === 'string') block.toolInput = p.input;
      if (p.rawInput) block.rawInput = p.rawInput;
    } else if (event.type === 'subagent_tool_result') {
      for (const block of state.blocks.values()) {
        if (block.toolId !== p.toolId) continue;
        if (typeof p.result === 'string') block.toolResult = p.result;
        if (typeof p.isError === 'boolean') block.toolError = p.isError;
        if (Array.isArray(p.images))
          block.toolResultImages = p.images as Array<{ id: string; mediaType: string }>;
      }
    } else if (event.type === 'subagent_end' || event.type === 'subagent_cancelled') {
      state.running = false;
      if (typeof p.summary === 'string') state.summary = p.summary;
      else if (event.type === 'subagent_cancelled') state.summary = 'Cancelled';
      if (p.usage && typeof p.usage === 'object') state.usage = p.usage as Record<string, number>;
    }
  }
  return (messageId: string, block: RestoredMessage['blocks'][number], active: boolean) => {
    const state = states.get(key(messageId, block.blockId));
    if (!state) return block;
    const blocks = state.order.map((id) => state.blocks.get(id)!);
    const subagent: RestoredSubagentState = {
      messageId: state.messageId,
      blocks: active && state.running ? blocks : blocks.map(({ done: _done, ...rest }) => rest),
      ...(active && state.running ? { running: true } : {}),
      ...(state.summary ? { summary: state.summary } : {}),
      ...(state.usage ? { usage: state.usage } : {}),
    };
    return { ...block, subagent };
  };
}

function nextReplayUser(
  messages: RestoredMessage[],
  commandId: string | undefined,
  provenance?: SymposiumProvenance,
): number {
  if (!commandId) return -1;
  const sameSource = (message: RestoredMessage) =>
    isDeepStrictEqual(message.symposiumProvenance, provenance);
  const owner = messages.findIndex(
    (message) => message.role === 'user' && message.messageId === commandId && sameSource(message),
  );
  if (owner < 0) return -1;
  return messages.findIndex(
    (message, index) => index > owner && message.role === 'user' && sameSource(message),
  );
}

/** Group only already-authorized synthetic feedback; this does not disclose any new event. */
function groupRetainedReplayErrors(messages: RestoredMessage[], events: StoredEvent[]): void {
  for (const event of events) {
    if (
      event.type !== 'error' ||
      event.payload.retainedCommandFailure !== true ||
      typeof event.payload.clientMsgId !== 'string'
    )
      continue;
    const errorIndex = messages.findIndex(
      (message) =>
        message.role === 'assistant' &&
        message.messageId === `runtime-error-${event.seq}` &&
        message.startedSeq === event.seq &&
        message.blocks[0]?.blockId === `runtime-error-text-${event.seq}` &&
        isDeepStrictEqual(message.symposiumProvenance, event.symposiumProvenance),
    );
    const next = nextReplayUser(messages, event.payload.clientMsgId, event.symposiumProvenance);
    if (next >= 0 && errorIndex > next) {
      const [error] = messages.splice(errorIndex, 1);
      messages.splice(next, 0, error);
    }
  }
}

/** Reconstruct the typed live turn from the same immutable event prefix as history. */
function replaySingleEventsToTranscript(
  events: StoredEvent[],
  initialPrompt?: string,
): { messages: RestoredMessage[]; current: RestoredCurrentMessage | null } {
  const attachSubagent = replaySubagents(events);
  const messages: RestoredMessage[] = [];
  const interruptCompleted = terminalProjection(messages);
  type ReplayBlock = RestoredCurrentMessage['blocks'][number];
  let turn: {
    messageId: string;
    timestamp: number;
    startedSeq: number;
    index: number;
    blocks: Map<string, ReplayBlock>;
  } | null = null;
  // Tool IDs can be reused by later turns. Bind each result to the exact
  // message/block occurrence in event order, including legacy results that
  // omitted messageId after another turn started.
  const toolResults = new Map<string, Record<string, unknown>>();
  const pendingResults = new Map<string, Array<Record<string, unknown>>>();
  const pendingBlocks = new Map<string, string[]>();
  const toolOwners = new Map<string, Set<string>>();
  const recordedToolIds = new Set(
    events.flatMap((event) =>
      event.type === 'block_end' && typeof event.payload.toolId === 'string'
        ? [event.payload.toolId]
        : [],
    ),
  );
  const uniqueToolOwners = new Map<string, string | null>();
  for (const event of events) {
    const p = event.payload;
    if (
      event.type === 'block_end' &&
      typeof p.toolId === 'string' &&
      typeof p.messageId === 'string' &&
      typeof p.blockId === 'string'
    )
      uniqueToolOwners.set(p.toolId, uniqueToolOwners.has(p.toolId) ? null : p.messageId);
  }
  let activeMessageId: string | null = null;
  for (const event of events) {
    const p = event.payload;
    if (event.type === 'message_start' && typeof p.messageId === 'string')
      activeMessageId = p.messageId;
    if (event.type === 'tool_result' && typeof p.toolId === 'string') {
      let messageId = typeof p.messageId === 'string' ? p.messageId : null;
      const owner = uniqueToolOwners.get(p.toolId);
      // Older query loops stamped delayed results with the active thinking
      // message. Repair only that ordinary-stream shape with one prior call;
      // keep seat attribution, reused IDs and unrelated explicit IDs strict.
      if (
        messageId &&
        messageId === activeMessageId &&
        event.seatId === undefined &&
        event.symposiumProvenance === undefined &&
        owner &&
        owner !== messageId &&
        pendingBlocks.get(JSON.stringify([owner, p.toolId]))?.length === 1
      )
        messageId = owner;
      if (!messageId) {
        const owners = toolOwners.get(p.toolId);
        if (owners && owners.size > 1)
          throw new Error('Ambiguous or unattributed late tool result in stored transcript');
        messageId = owners?.size === 1 ? [...owners][0] : activeMessageId;
      }
      // Resumed legacy providers may repeat results for calls absent from
      // the durable stream. There is no block to display them on. Leave the
      // stored event intact and restore the rest of the conversation.
      if (
        !messageId &&
        event.seatId === undefined &&
        event.symposiumProvenance === undefined &&
        !recordedToolIds.has(p.toolId)
      )
        continue;
      if (!messageId)
        throw new Error('Ambiguous or unattributed late tool result in stored transcript');
      const key = JSON.stringify([messageId, p.toolId]);
      const waiting = pendingBlocks.get(key);
      if (waiting?.length) toolResults.set(JSON.stringify([messageId, waiting.shift()]), p);
      else pendingResults.set(key, [...(pendingResults.get(key) ?? []), p]);
    }
    if (
      event.type === 'block_end' &&
      typeof p.messageId === 'string' &&
      typeof p.blockId === 'string' &&
      typeof p.toolId === 'string'
    ) {
      const owners = toolOwners.get(p.toolId) ?? new Set<string>();
      owners.add(p.messageId);
      toolOwners.set(p.toolId, owners);
      const key = JSON.stringify([p.messageId, p.toolId]);
      const waiting = pendingResults.get(key);
      if (waiting?.length)
        toolResults.set(JSON.stringify([p.messageId, p.blockId]), waiting.shift()!);
      else pendingBlocks.set(key, [...(pendingBlocks.get(key) ?? []), p.blockId]);
    }
    if (
      (event.type === 'message_end' && p.messageId === activeMessageId) ||
      event.type === 'session_end'
    )
      activeMessageId = null;
  }
  if (
    [...pendingResults.values()].some((results) =>
      results.some((result) => typeof result.messageId === 'string'),
    )
  )
    throw new Error('Unmatched attributed tool result in stored transcript');

  // Legacy sessions persisted their first user prompt after message_start.
  // Keep that compatibility while ordering every subsequent event as stored.
  let seenStart = false;
  let seenEnd = false;
  let seenUser = false;
  let legacyInitial: (typeof events)[number] | undefined;
  for (const event of events) {
    if (event.type === 'user_message') {
      if (!initialPrompt && seenStart && !seenEnd && !seenUser) legacyInitial = event;
      seenUser = true;
    }
    if (event.type === 'message_start') seenStart = true;
    if (event.type === 'message_end' || event.type === 'session_end') seenEnd = true;
  }
  const promptEvent = initialPrompt
    ? events.find((event) => event.type === 'user_message' && event.payload.text === initialPrompt)
    : legacyInitial;
  const userMessage = (event: (typeof events)[number]): RestoredMessage => {
    const payload = event.payload;
    const messageId = payload.messageId as string;
    return {
      messageId,
      role: 'user',
      timestamp: typeof payload.ts === 'number' ? payload.ts : event.createdAt,
      startedSeq: event.seq,
      completedSeq: event.seq,
      images: Array.isArray(payload.images) ? (payload.images as string[]) : undefined,
      sourceSnapshots: SourceSnapshotsSchema.safeParse(payload.sourceSnapshots).data,
      contextBlocks: Array.isArray(payload.contextBlocks)
        ? (payload.contextBlocks as string[])
        : undefined,
      blocks: [
        { blockId: `user-${messageId}`, blockType: 'text', content: payload.text as string },
      ],
    };
  };
  if (initialPrompt) {
    const firstStart = events.findIndex((event) => event.type === 'message_start');
    const hoistedPrompt =
      promptEvent && firstStart >= 0 && firstStart < events.indexOf(promptEvent);
    const prompt = promptEvent
      ? userMessage(promptEvent)
      : {
          messageId: 'umsg-initial',
          role: 'user',
          blocks: [{ blockId: 'user-initial', blockType: 'text', content: initialPrompt }],
        };
    messages.push({
      ...prompt,
      ...(hoistedPrompt ? { startedSeq: undefined, completedSeq: undefined } : {}),
      timestamp: events[0]?.createdAt,
    });
  } else if (legacyInitial) {
    const hoisted = userMessage(legacyInitial);
    delete hoisted.startedSeq;
    delete hoisted.completedSeq;
    messages.push(hoisted);
  }

  const materializeBlocks = (active: boolean) => {
    if (!turn) return [];
    return [...turn.blocks.values()].map((block) => {
      const result = block.toolId
        ? toolResults.get(JSON.stringify([turn!.messageId, block.blockId]))
        : undefined;
      const restored = {
        ...block,
        ...(result && typeof result.result === 'string' ? { toolResult: result.result } : {}),
        ...(result && typeof result.isError === 'boolean' ? { toolError: result.isError } : {}),
        ...(result && Array.isArray(result.images)
          ? { toolResultImages: result.images as Array<{ id: string; mediaType: string }> }
          : {}),
      };
      return { ...block, ...attachSubagent(turn!.messageId, restored, active) };
    });
  };
  const finishTurn = (completedSeq?: number) => {
    if (!turn) return;
    const blocks = materializeBlocks(false).map(({ done: _done, ...block }) => block);
    if (blocks.length > 0)
      messages[turn.index] = {
        messageId: turn.messageId,
        role: 'assistant',
        timestamp: turn.timestamp,
        startedSeq: turn.startedSeq,
        ...(completedSeq === undefined ? {} : { completedSeq }),
        blocks,
      };
    else messages.splice(turn.index, 1);
    turn = null;
  };

  const acceptedSessions: AcceptedReplaySessions = new Map();
  for (const event of events) {
    recordAcceptedReplaySession(event, acceptedSessions);
    const payload = event.payload;
    switch (event.type) {
      case 'user_message':
        if (event === promptEvent) break;
        messages.push(userMessage(event));
        break;
      case 'message_start':
        finishTurn();
        if (typeof payload.messageId === 'string') {
          const timestamp = typeof payload.ts === 'number' ? payload.ts : event.createdAt;
          turn = {
            messageId: payload.messageId,
            timestamp,
            startedSeq: event.seq,
            index: messages.length,
            blocks: new Map(),
          };
          messages.push({
            messageId: payload.messageId,
            role: 'assistant',
            timestamp,
            startedSeq: event.seq,
            blocks: [],
          });
        }
        break;
      case 'block_start':
        if (
          turn &&
          payload.messageId === turn.messageId &&
          typeof payload.blockId === 'string' &&
          typeof payload.blockType === 'string'
        )
          turn.blocks.set(payload.blockId, {
            blockId: payload.blockId,
            blockType: payload.blockType,
            content: '',
            done: false,
            ...(typeof payload.toolName === 'string' ? { toolName: payload.toolName } : {}),
          });
        break;
      case 'block_delta': {
        if (!turn || payload.messageId !== turn.messageId) break;
        const block = turn.blocks.get(payload.blockId as string);
        if (block && typeof payload.delta === 'string') block.content += payload.delta;
        break;
      }
      case 'block_end': {
        if (!turn || payload.messageId !== turn.messageId) break;
        const block = turn.blocks.get(payload.blockId as string);
        if (!block) break;
        block.done = true;
        if (typeof payload.toolName === 'string') block.toolName = payload.toolName;
        if (typeof payload.toolId === 'string') block.toolId = payload.toolId;
        if (typeof payload.input === 'string') block.toolInput = payload.input;
        if (payload.rawInput) block.rawInput = payload.rawInput;
        break;
      }
      case 'message_end':
        if (turn && payload.messageId === turn.messageId) finishTurn(event.seq);
        break;
      case 'error': {
        const failure = replayError(event, acceptedSessions);
        if (failure) {
          const nextUser = nextReplayUser(messages, failure.clientMsgId);
          // A late failure for A must not terminate the typed current turn B.
          if (nextUser < 0 || (turn && turn.index < nextUser)) finishTurn();
          messages.push({
            messageId: `${failure.prefix}-${event.seq}`,
            role: 'assistant',
            timestamp: event.createdAt,
            startedSeq: event.seq,
            completedSeq: event.seq,
            blocks: [
              {
                blockId: `${failure.prefix}-text-${event.seq}`,
                blockType: 'text',
                content: `**Error:** ${failure.message}`,
              },
            ],
          });
        }
        break;
      }
      case 'session_end':
        finishTurn();
        interruptCompleted();
        break;
    }
  }
  if (turn) messages.splice(turn.index, 1);
  groupRetainedReplayErrors(messages, events);
  return {
    messages,
    current: turn
      ? { messageId: turn.messageId, startedSeq: turn.startedSeq, blocks: materializeBlocks(true) }
      : null,
  };
}

/** Restore each immutable seat stream independently so reused block IDs cannot cross seats. */
export function replayEventsToTranscript(
  events: StoredEvent[],
  initialPrompt?: string,
): {
  messages: RestoredMessage[];
  current: RestoredCurrentMessage | null;
  currents: RestoredCurrentMessage[];
} {
  const ordinary: typeof events = [];
  const bySnapshot = new Map<string, { events: typeof events; provenance: SymposiumProvenance }>();
  const globalTerminals: typeof events = [];
  const openBySeat = new Map<
    string,
    { messageId: string; snapshotKey: string; blockIds: Set<string> }
  >();
  const completedTurns = new Set<string>();
  for (const event of events) {
    if (event.seatId === undefined && event.symposiumProvenance === undefined) {
      // These host bookkeeping records name a recipient, not a transcript author.
      // Never infer provenance from their payload or broaden this to arbitrary events.
      if (
        !('symposiumProvenance' in event.payload) &&
        (event.type === 'symposium_delivery_dispatched' ||
          event.type === 'symposium_thread_migrated')
      )
        continue;
      if ('seatId' in event.payload || 'symposiumProvenance' in event.payload)
        throw new Error('Stored event has unverifiable Symposium attribution');
      ordinary.push(event);
      if (event.type === 'session_end') {
        globalTerminals.push(event);
        for (const active of openBySeat.values())
          completedTurns.add(JSON.stringify([active.snapshotKey, active.messageId]));
        openBySeat.clear();
      }
      continue;
    }
    const parsed = SymposiumProvenanceSchema.safeParse(event.symposiumProvenance);
    if (!parsed.success || event.seatId !== parsed.data.seatId)
      throw new Error('Stored Symposium event has mismatched seat provenance');
    // Schema parsing provides a stable field order for equivalent snapshots.
    const key = JSON.stringify(parsed.data);
    const seatGeneration = JSON.stringify([
      parsed.data.seatId,
      parsed.data.membershipGeneration ?? null,
    ]);
    const active = openBySeat.get(seatGeneration);
    if (event.type === 'message_start') {
      if (active) throw new Error('Ambiguous simultaneous Symposium turns for one seat');
      if (typeof event.payload.messageId !== 'string' || !event.payload.messageId)
        throw new Error('Stored Symposium message_start has no message identity');
      openBySeat.set(seatGeneration, {
        messageId: event.payload.messageId,
        snapshotKey: key,
        blockIds: new Set(),
      });
    } else if (event.type === 'message_end') {
      const terminalIdentity = JSON.stringify([key, event.payload.messageId]);
      if (active && active.messageId === event.payload.messageId && active.snapshotKey === key) {
        completedTurns.add(terminalIdentity);
        openBySeat.delete(seatGeneration);
      } else if (completedTurns.has(terminalIdentity)) {
        // A delayed duplicate must not close or invalidate a newer active turn.
        continue;
      } else {
        throw new Error('Stored Symposium message_end mismatches active seat turn');
      }
    } else if (event.type === 'session_end') {
      if (active && active.snapshotKey !== key)
        throw new Error('Stored Symposium terminal mismatches active seat snapshot');
      if (active) completedTurns.add(JSON.stringify([active.snapshotKey, active.messageId]));
      openBySeat.delete(seatGeneration);
    } else if (['block_start', 'block_delta', 'block_end'].includes(event.type)) {
      if (!active || active.messageId !== event.payload.messageId || active.snapshotKey !== key)
        throw new Error('Stored Symposium block mismatches active seat turn');
      if (typeof event.payload.blockId !== 'string' || !event.payload.blockId)
        throw new Error('Stored Symposium block has no identity');
      if (event.type === 'block_start') active.blockIds.add(event.payload.blockId);
      else if (!active.blockIds.has(event.payload.blockId))
        throw new Error('Stored Symposium block has no matching start');
    } else if (event.type.startsWith('subagent_')) {
      if (
        !active ||
        active.snapshotKey !== key ||
        typeof event.payload.parentBlockId !== 'string' ||
        !active.blockIds.has(event.payload.parentBlockId)
      )
        throw new Error('Stored Symposium subagent mismatches active seat turn');
    }
    let stream = bySnapshot.get(key);
    if (!stream) {
      stream = { events: [], provenance: parsed.data };
      bySnapshot.set(key, stream);
    }
    stream.events.push(event);
  }

  const base = replaySingleEventsToTranscript(ordinary, initialPrompt);
  const messages = [...base.messages];
  const currents: RestoredCurrentMessage[] = [];
  const activeSeats = new Set<string>();
  for (const { events: streamEvents, provenance } of bySnapshot.values()) {
    const stream = replaySingleEventsToTranscript(
      [...streamEvents, ...globalTerminals].sort((a, b) => a.seq - b.seq),
    );
    messages.push(
      ...stream.messages.map((message) => ({ ...message, symposiumProvenance: provenance })),
    );
    if (!stream.current) continue;
    const seatGeneration = JSON.stringify([
      provenance.seatId,
      provenance.membershipGeneration ?? null,
    ]);
    if (activeSeats.has(seatGeneration))
      throw new Error('Ambiguous simultaneous Symposium turns for one seat');
    activeSeats.add(seatGeneration);
    currents.push({ ...stream.current, symposiumProvenance: provenance });
  }
  messages.sort((a, b) => (a.startedSeq ?? -1) - (b.startedSeq ?? -1));
  groupRetainedReplayErrors(messages, events);
  currents.sort((a, b) => (a.startedSeq ?? -1) - (b.startedSeq ?? -1));
  const ids = new Set<string>();
  for (const message of [...messages, ...currents]) {
    const id = JSON.stringify([
      message.symposiumProvenance?.seatId ?? null,
      message.symposiumProvenance?.membershipGeneration ?? null,
      message.messageId,
    ]);
    if (ids.has(id))
      throw new Error('Ambiguous duplicate Symposium message identity in stored transcript');
    ids.add(id);
  }
  return { messages, current: base.current, currents };
}

/**
 * Replay v2 events from the event store into finished messages.
 *
 * @param initialPrompt — If provided (from session metadata), injected as the
 *   first user message. This is the primary mechanism for initial prompts.
 *   Legacy sessions that stored the initial prompt as an out-of-order
 *   user_message event are still handled as a fallback.
 */
/** Exported for testing. */
export function replayEventsToMessages(
  events: StoredEvent[],
  initialPrompt?: string,
): RestoredMessage[] {
  // Historical REST reads must use the same immutable seat partitioning as
  // bounded reconnect. The legacy single-stream builder below cannot keep
  // simultaneous turns or reused block IDs separate, and would omit their
  // provenance from the response.
  if (
    events.some(
      (event) =>
        event.seatId !== undefined ||
        event.symposiumProvenance !== undefined ||
        'seatId' in event.payload ||
        'symposiumProvenance' in event.payload,
    )
  ) {
    const restored = replayEventsToTranscript(events, initialPrompt);
    const partials = [restored.current, ...restored.currents]
      .filter((current): current is RestoredCurrentMessage => current !== null)
      .map((current): RestoredMessage => ({ ...current, role: 'assistant' }));
    const messages = [...restored.messages, ...partials].sort(
      (a, b) => (a.startedSeq ?? -1) - (b.startedSeq ?? -1),
    );
    groupRetainedReplayErrors(messages, events);
    return messages;
  }
  const messages: RestoredMessage[] = [];
  const interruptCompleted = terminalProjection(messages);
  let currentMsg: RestoredMessage | null = null;
  const blockContent = new Map<string, string>();
  const toolResults = new Map<string, { result: string; isError: boolean }>();
  const acceptedSessions: AcceptedReplaySessions = new Map();
  const scopedBlocks = new Map<
    string,
    {
      payload: Record<string, unknown>;
      content: string;
      closed?: RestoredMessage['blocks'][number];
    }
  >();
  const restoreBlock = (
    p: Record<string, unknown>,
    content: string,
  ): RestoredMessage['blocks'][number] => {
    const toolId = p.toolId as string | undefined;
    const tr = toolId ? toolResults.get(toolId) : undefined;
    return {
      blockId: p.blockId as string,
      blockType: p.blockType as string,
      content,
      ...(p.toolName ? { toolName: p.toolName as string } : {}),
      ...(toolId ? { toolId } : {}),
      ...(p.input ? { toolInput: p.input as string } : {}),
      ...(p.rawInput ? { rawInput: p.rawInput } : {}),
      ...(tr ? { toolResult: tr.result, toolError: tr.isError } : {}),
    };
  };

  // First pass: collect tool results and detect legacy out-of-order initial prompts.
  // Legacy sessions stored the initial user_message after the first assistant turn
  // (sessionId wasn't known until the first assistant event). Detect these so we
  // can either skip them (if initialPrompt is provided) or reorder them (fallback).
  let legacyInitialPromptEvent: StoredEvent | null = null;
  let seenMessageStart = false;
  let seenMessageEnd = false;
  for (const evt of events) {
    if (evt.type === 'tool_result') {
      const p = evt.payload;
      toolResults.set(p.toolId as string, {
        result: p.result as string,
        isError: (p.isError as boolean) ?? false,
      });
    }
    if (evt.type === 'message_start') seenMessageStart = true;
    if (evt.type === 'message_end' || evt.type === 'session_end') seenMessageEnd = true;
    // A user_message that appears after message_start but before any message_end
    // is an out-of-order initial prompt from the legacy storage path.
    // After the first message_end, user_messages are normal follow-ups.
    if (evt.type === 'user_message' && seenMessageStart && !seenMessageEnd) {
      if (!legacyInitialPromptEvent) legacyInitialPromptEvent = evt;
    }
  }

  // Inject the initial prompt as the first message.
  // Priority: initialPrompt param (from session metadata) > legacy out-of-order event
  if (initialPrompt) {
    // Reuse the stored messageId so REST recovery and WS replay agree on IDs
    const matchingEvt = events.find(
      (e) => e.type === 'user_message' && e.payload.text === initialPrompt,
    );
    const messageId = matchingEvt ? (matchingEvt.payload.messageId as string) : 'umsg-initial';
    const firstTs = events[0]?.createdAt;
    messages.push({
      messageId,
      role: 'user',
      timestamp: firstTs,
      images: Array.isArray(matchingEvt?.payload.images)
        ? (matchingEvt.payload.images as string[])
        : undefined,
      sourceSnapshots: SourceSnapshotsSchema.safeParse(matchingEvt?.payload.sourceSnapshots).data,
      contextBlocks: Array.isArray(matchingEvt?.payload.contextBlocks)
        ? (matchingEvt.payload.contextBlocks as string[])
        : undefined,
      blocks: [{ blockId: 'user-initial', blockType: 'text', content: initialPrompt }],
    });
  } else if (legacyInitialPromptEvent) {
    const p = legacyInitialPromptEvent.payload;
    messages.push({
      messageId: p.messageId as string,
      role: 'user',
      timestamp: typeof p.ts === 'number' ? p.ts : legacyInitialPromptEvent.createdAt,
      images: Array.isArray(p.images) ? (p.images as string[]) : undefined,
      sourceSnapshots: SourceSnapshotsSchema.safeParse(p.sourceSnapshots).data,
      contextBlocks: Array.isArray(p.contextBlocks) ? (p.contextBlocks as string[]) : undefined,
      blocks: [
        {
          blockId: `user-${p.messageId as string}`,
          blockType: 'text',
          content: p.text as string,
        },
      ],
    });
  }

  for (const evt of events) {
    recordAcceptedReplaySession(evt, acceptedSessions);
    // Skip legacy out-of-order initial prompt — already injected above
    if (evt === legacyInitialPromptEvent) continue;
    // Skip any user_message event whose text matches the injected initialPrompt
    // (prevents duplicates from legacy events still in the store)
    if (initialPrompt && evt.type === 'user_message' && evt.payload.text === initialPrompt)
      continue;
    const p = evt.payload;
    switch (evt.type) {
      case 'user_message':
        if (currentMsg && currentMsg.blocks.length > 0) {
          messages.push(currentMsg);
          currentMsg = null;
        }
        messages.push({
          messageId: p.messageId as string,
          role: 'user',
          timestamp: typeof p.ts === 'number' ? p.ts : evt.createdAt,
          images: Array.isArray(p.images) ? (p.images as string[]) : undefined,
          sourceSnapshots: SourceSnapshotsSchema.safeParse(p.sourceSnapshots).data,
          contextBlocks: Array.isArray(p.contextBlocks) ? (p.contextBlocks as string[]) : undefined,
          blocks: [
            {
              blockId: `user-${p.messageId as string}`,
              blockType: 'text',
              content: p.text as string,
            },
          ],
        });
        break;

      case 'message_start':
        if (currentMsg && currentMsg.blocks.length > 0) {
          messages.push(currentMsg);
        }
        scopedBlocks.clear();
        currentMsg = {
          messageId: p.messageId as string,
          role: 'assistant',
          timestamp: typeof p.ts === 'number' ? p.ts : evt.createdAt,
          blocks: [],
        };
        break;

      case 'block_start':
        if (currentMsg) {
          blockContent.set(p.blockId as string, '');
          if (
            p.messageId === currentMsg.messageId &&
            typeof p.blockId === 'string' &&
            typeof p.blockType === 'string'
          )
            scopedBlocks.set(p.blockId, { payload: p, content: '' });
        }
        break;

      case 'block_delta':
        if (currentMsg) {
          const existing = blockContent.get(p.blockId as string) ?? '';
          blockContent.set(p.blockId as string, existing + (p.delta as string));
          const scoped = scopedBlocks.get(p.blockId as string);
          if (scoped && p.messageId === currentMsg.messageId && typeof p.delta === 'string')
            scoped.content += p.delta;
        }
        break;

      case 'block_end':
        if (currentMsg) {
          const content = blockContent.get(p.blockId as string) ?? '';
          const block = restoreBlock(p, content);
          currentMsg.blocks.push(block);
          const scoped = scopedBlocks.get(p.blockId as string);
          if (scoped && p.messageId === currentMsg.messageId) scoped.closed = block;
          blockContent.delete(p.blockId as string);
        }
        break;

      case 'error': {
        const failure = replayError(evt, acceptedSessions);
        if (failure) {
          const olderCommand = nextReplayUser(messages, failure.clientMsgId) >= 0;
          if (!olderCommand && failure.prefix === 'runtime-error' && currentMsg) {
            // Preserve incomplete blocks without changing legacy completed-block metadata.
            currentMsg.blocks = [
              ...[...scopedBlocks.values()].map(
                (block) => block.closed ?? restoreBlock(block.payload, block.content),
              ),
              ...currentMsg.blocks.filter((block) => !scopedBlocks.has(block.blockId)),
            ];
          }
          if (!olderCommand) {
            if (currentMsg && currentMsg.blocks.length > 0) messages.push(currentMsg);
            currentMsg = null;
          }
          messages.push({
            messageId: `${failure.prefix}-${evt.seq}`,
            role: 'assistant',
            timestamp: evt.createdAt,
            startedSeq: evt.seq,
            blocks: [
              {
                blockId: `${failure.prefix}-text-${evt.seq}`,
                blockType: 'text',
                content: `**Error:** ${failure.message}`,
              },
            ],
          });
        }
        break;
      }

      case 'message_end':
        if (currentMsg && currentMsg.blocks.length > 0) {
          messages.push(currentMsg);
        }
        currentMsg = null;
        break;

      case 'session_end':
        if (currentMsg && currentMsg.blocks.length > 0) messages.push(currentMsg);
        currentMsg = null;
        interruptCompleted();
        break;
    }
  }

  // Flush any in-flight message
  if (currentMsg && currentMsg.blocks.length > 0) {
    messages.push(currentMsg);
  }

  groupRetainedReplayErrors(messages, events);
  return messages;
}

// --- Legacy SDK JSONL reconstruction (fallback for pre-migration sessions) ---

export interface RawSdkMessage {
  type: string;
  message?: Record<string, unknown>;
}

export function reconstructMessages(rawMessages: RawSdkMessage[]): RestoredMessage[] {
  let blockCounter = 0;

  const toolResultMap = new Map<string, { result: string; isError: boolean }>();
  const parsedMessages = rawMessages.map((m) => {
    const content = m.message?.content;
    const parsed = Array.isArray(content) ? parseContentBlocks(content) : undefined;
    for (const tr of parsed?.toolResults ?? []) {
      toolResultMap.set(tr.toolId, { result: tr.result, isError: tr.isError });
    }
    return { m, content, parsed };
  });

  const messages: RestoredMessage[] = [];

  for (const { m, content, parsed } of parsedMessages) {
    const role = m.type === 'assistant' ? 'assistant' : 'user';
    const msgId = (m.message?.id as string) ?? `restored-${Date.now()}-${blockCounter}`;
    const blocks: RestoredMessage['blocks'] = [];

    if (typeof content === 'string') {
      if (content) {
        blocks.push({
          blockId: `rb${blockCounter++}`,
          blockType: 'text',
          content,
        });
      }
    } else if (parsed) {
      if (!parsed.text && parsed.toolCalls.length === 0) continue;

      if (parsed.text) {
        blocks.push({
          blockId: `rb${blockCounter++}`,
          blockType: 'text',
          content: parsed.text,
        });
      }

      for (const tc of parsed.toolCalls) {
        blocks.push({
          blockId: `rb${blockCounter++}`,
          blockType: 'tool_use',
          content: '',
          toolName: tc.toolName,
          toolId: tc.toolId,
          toolInput: tc.input,
          toolResult: toolResultMap.get(tc.toolId)?.result,
          ...(toolResultMap.has(tc.toolId)
            ? { toolError: toolResultMap.get(tc.toolId)!.isError }
            : {}),
        });
      }
    } else {
      continue;
    }

    if (blocks.length === 0) continue;
    messages.push({ messageId: msgId, role, blocks });
  }

  return messages;
}
