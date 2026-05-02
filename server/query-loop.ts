import type { SessionTransport, ConnectionRegistry } from '@mitzo/harness';
import { summarizeToolInput, getRawInput } from './tool-summary.js';
import { extractToolResultText } from './content-blocks.js';
import {
  TOOL_RESULT_MAX_CHARS,
  CONTEXT_CEILING_TOKENS,
  QUERY_FIRST_EVENT_TIMEOUT_MS,
  TRACE_CONTENT_MAX_CHARS,
} from './constants.js';
import { createLogger } from './logger.js';
import type { SessionRegistry, SnapshotBlock } from './session-registry.js';
import type { EventStore } from './event-store.js';
import { updateSessionSdkId } from './session-index.js';
import { sendTurnCompleteNotification as ntfyTurnComplete } from './notify.js';
import { sendTurnCompleteNotification as pushoverTurnComplete } from './pushover.js';
import { sendTurnCompleteNotification as apnsTurnComplete } from './apns.js';
import { extractSnippet } from './notification-helpers.js';
import { NOTIFY_SNIPPET_MAX_CHARS } from './constants.js';
import { createGoal, reportUsage, deriveGoalTitle } from './goal-client.js';
import { tracer } from './tracing.js';
import { context, trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { ProgressTracker } from './progress-tracker.js';
const log = createLogger('query-loop');

/** Truncate text for trace/log payloads, returning a truncated flag when clipped. */
function truncateForTrace(text: string): { text: string; truncated?: true } {
  if (text.length <= TRACE_CONTENT_MAX_CHARS) return { text };
  return { text: text.slice(0, TRACE_CONTENT_MAX_CHARS), truncated: true };
}

/** Send data via transport, guarding on isOpen(). */
function send(transport: SessionTransport, data: Record<string, unknown>) {
  if (transport.isOpen()) transport.send(data);
}

/** Shape of the SDK result event — fields we extract for usage tracking. */
interface SdkResultEvent {
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  duration_api_ms?: number;
}

/**
 * Broadcast a message to all observers of a session.
 * Each send is wrapped in try/catch to prevent a single failing socket
 * (e.g. transitioning to CLOSING between readyState check and send)
 * from aborting the broadcast loop.
 */
export function broadcastToObservers(
  observers: Set<SessionTransport>,
  data: Record<string, unknown>,
): void {
  if (observers.size === 0) return;
  for (const obs of observers) {
    if (!obs.isOpen()) continue;
    try {
      obs.send(data);
    } catch {
      // Transport may have closed between check and send — safe to ignore
    }
  }
}

/**
 * Persist a v2 event to the durable store (if available), then send or buffer.
 * The store.append() is synchronous and happens before WS delivery,
 * so events survive even if the connection drops mid-send.
 */
function sendOrBuffer(
  data: Record<string, unknown>,
  clientId: string,
  registry: SessionRegistry,
  store?: EventStore,
  sessionId?: string,
  connRegistry?: ConnectionRegistry,
) {
  let enriched: Record<string, unknown> = data;
  // Tag v2 events with sessionId for v2 client demuxing. v1 clients
  // ignore the extra field. Persist to the durable store before delivery.
  if (data.v === 2 && sessionId) {
    enriched = { ...data, sessionId };
    if (store) {
      const seq = store.append(sessionId, data.type as string, enriched);
      enriched = { ...enriched, seq };
    }
  }

  // Suspend buffer: if the session is proactively suspended (iOS backgrounding),
  // buffer events instead of delivering via the driver transport (which is
  // dying). Still broadcast to other watchers — suspend is per-clientId, not
  // per-session. The driver's dead WS will be skipped by broadcast's isOpen()
  // check, and events are durable in EventStore regardless.
  if (registry.isSuspended(clientId)) {
    registry.bufferEvent(clientId, enriched);
    if (sessionId && connRegistry?.hasOpenWatchers(sessionId)) {
      connRegistry.broadcast(sessionId, enriched);
    }
    return;
  }

  // v2 path: deliver via ConnectionRegistry when there are open connections
  // watching this session. Uses sessionId-based fan-out instead of checking
  // whether the originating clientId is still registered — after a WS
  // reconnect the original connection is gone but new ones may be watching.
  if (sessionId && connRegistry?.hasOpenWatchers(sessionId)) {
    connRegistry.broadcast(sessionId, enriched);
    return;
  }

  // v1 path (or pre-sessionId fallback for v2): driver transport + observers
  const session = registry.get(clientId);
  if (session) {
    if (registry.isAttached(clientId)) {
      send(session.transport, enriched);
    }
    broadcastToObservers(session.observers, enriched);
  }
}

function v2(type: string, rest: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 2, type, ts: Date.now(), ...rest };
}

export interface QueryLoopOptions {
  connRegistry?: ConnectionRegistry;
  onSessionResolved?: (sessionId: string) => void;
  /** Called after the initial prompt is registered, enabling auto-rename on prompt 1. */
  onInitialPrompt?: (sessionId: string) => void;
  /** Called when an assistant turn completes (snapshot cleared). */
  onTurnEnd?: (clientId: string) => void;
}

export async function runQueryLoop(
  q: AsyncIterable<Record<string, unknown>>,
  clientId: string,
  registry: SessionRegistry,
  abortController: AbortController,
  store?: EventStore,
  initialPrompt?: string,
  options?: QueryLoopOptions,
) {
  const span = tracer.startSpan('session');
  span.setAttribute('session.clientId', clientId);
  const sessionContext = trace.setSpan(context.active(), span);

  // Run the entire loop body inside the session span's context so that:
  // - All log.info() calls inject trace_id/span_id via the pino OTel mixin
  // - Child spans (turn, tool) inherit the session span as parent
  return context.with(sessionContext, () =>
    _runQueryLoopInner(q, clientId, registry, abortController, span, store, initialPrompt, options),
  );
}

async function _runQueryLoopInner(
  q: AsyncIterable<Record<string, unknown>>,
  clientId: string,
  registry: SessionRegistry,
  abortController: AbortController,
  span: Span,
  store?: EventStore,
  initialPrompt?: string,
  options?: QueryLoopOptions,
) {
  const connRegistry = options?.connRegistry;
  const onSessionResolved = options?.onSessionResolved;
  const onInitialPrompt = options?.onInitialPrompt;
  // Tool input buffers keyed by content block index (reset per message_start).
  const toolInputBuffers = new Map<
    number,
    { name: string; id: string; inputBuf: string; blockId: string }
  >();

  // Progress tracker — intercepts TodoWrite calls, emits structured events.
  const progressTracker = new ProgressTracker();

  // Map content block index → blockId for all block types.
  const blockIdByIndex = new Map<number, string>();

  let blockCounter = 0;
  let currentMessageId: string | null = null;
  let doneSent = false;
  let openBlockCount = 0;
  let pendingMessageEnd: Record<string, unknown> | null = null;
  let resolvedSessionId: string | undefined;
  let resolvedGoalId: string | undefined;
  let goalCreationPromise: Promise<string | null> | undefined;
  let goalTitle: string | undefined;

  // Turn and tool span tracking
  let currentTurnSpan: Span | null = null;
  let turnBlockCount = 0;
  const toolSpans = new Map<string, Span>(); // blockId → tool span

  // Token tracking state for live token_update events
  let agentContextTokens = 0; // full context window size (input + cached) from parent message_start
  let turnIndex = 0; // increments on each parent message_start (excludes sub-agents)
  let numCompactions = 0; // counts successful compaction events from SDK
  let liveSessionTokens = 0; // cumulative total across all API calls in this query
  let cumulativeOutputTokens = 0; // accumulated output tokens (fresh per API call)
  const compactionFields = () => (numCompactions > 0 ? { numCompactions } : {});

  // Track last-reported cumulative usage to compute deltas (SDK reports cumulative totals).
  let lastReportedUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalCostUsd: 0,
    numTurns: 0,
    durationMs: 0,
    durationApiMs: 0,
  };

  // Buffer v2 events emitted before sessionId is known (first turn of new
  // sessions). Once the sessionId resolves, these are flushed to the durable
  // store so reconnecting clients can reconstruct the full message.
  const preSessionBuffer: Record<string, unknown>[] = [];

  /** Wrapper that auto-injects store + sessionId + connRegistry into sendOrBuffer */
  function emit(data: Record<string, unknown>) {
    if (!resolvedSessionId && data.v === 2) {
      preSessionBuffer.push(data);
    }
    sendOrBuffer(data, clientId, registry, store, resolvedSessionId, connRegistry);
  }

  /** Flush buffered pre-sessionId events to the durable store. */
  function flushPreSessionBuffer() {
    if (!store || !resolvedSessionId || preSessionBuffer.length === 0) return;
    for (const event of preSessionBuffer) {
      store.append(resolvedSessionId, event.type as string, {
        ...event,
        sessionId: resolvedSessionId,
      });
    }
    preSessionBuffer.length = 0;
  }

  function nextBlockId(): string {
    return `b${blockCounter++}`;
  }

  function tryFlushMessageEnd(session: { currentSnapshot: unknown | null }) {
    if (pendingMessageEnd && openBlockCount === 0) {
      emit(pendingMessageEnd);
      pendingMessageEnd = null;
      currentMessageId = null;
      (session as { currentSnapshot: null }).currentSnapshot = null;
      // End turn span when message is fully flushed
      if (currentTurnSpan) {
        currentTurnSpan.setAttribute('turn.block_count', turnBlockCount);
        currentTurnSpan.setStatus({ code: SpanStatusCode.OK });
        currentTurnSpan.end();
        currentTurnSpan = null;
      }
      options?.onTurnEnd?.(clientId);
    }
  }

  function forceFlushPendingMessage(session: {
    currentSnapshot: { blocks: SnapshotBlock[] } | null;
  }) {
    if (!pendingMessageEnd) return;
    for (const [index, bid] of blockIdByIndex) {
      if (openBlockCount <= 0) break;
      const snap = session.currentSnapshot?.blocks.find((b) => b.blockId === bid);
      if (snap && !snap.done) {
        snap.done = true;
        const toolEntry = toolInputBuffers.get(index);
        if (toolEntry) {
          toolInputBuffers.delete(index);
          let toolInput: Record<string, unknown> = {};
          try {
            toolInput = JSON.parse(toolEntry.inputBuf || '{}');
          } catch {
            /* empty */
          }
          emit(
            v2('block_end', {
              messageId: currentMessageId,
              blockId: bid,
              blockType: 'tool_use',
              toolName: toolEntry.name,
              toolId: toolEntry.id,
              input: summarizeToolInput(toolEntry.name, toolInput),
            }),
          );
        } else {
          emit(
            v2('block_end', {
              messageId: currentMessageId,
              blockId: bid,
              blockType: snap.blockType,
            }),
          );
        }
        openBlockCount = Math.max(0, openBlockCount - 1);
      }
    }
    emit(pendingMessageEnd);
    pendingMessageEnd = null;
    currentMessageId = null;
    session.currentSnapshot = null;
  }

  log.info('query loop started', { clientId });

  // If the SDK yields no events within QUERY_FIRST_EVENT_TIMEOUT_MS, abort
  // the query and surface an error to the client. This unblocks turns where
  // the configured model is unreachable (e.g. requested via Vertex AI before
  // that model has landed there) and would otherwise hang indefinitely.
  let firstEventReceived = false;
  let timedOut = false;
  const firstEventTimer = setTimeout(() => {
    if (!firstEventReceived) {
      timedOut = true;
      abortController.abort();
    }
  }, QUERY_FIRST_EVENT_TIMEOUT_MS);

  try {
    // outer try ensures span.end() always fires
    try {
      for await (const msg of q) {
        if (!firstEventReceived) {
          firstEventReceived = true;
          clearTimeout(firstEventTimer);
        }
        const currentSession = registry.get(clientId);
        if (!currentSession) break;
        if (!resolvedSessionId && currentSession.sessionId) {
          resolvedSessionId = currentSession.sessionId;
          flushPreSessionBuffer();
          // Resumed sessions: load goalId from store so usage reporting works
          if (store && !resolvedGoalId) {
            const existingSession = store.getSession(resolvedSessionId);
            if (existingSession?.goalId) {
              resolvedGoalId = existingSession.goalId;
              log.info('resumed session goal', {
                sessionId: resolvedSessionId,
                goalId: resolvedGoalId,
              });
            }
          }
        }

        log.debug('sdk event', { clientId, type: msg.type });

        if (msg.type === 'assistant') {
          // Turn complete — defer message_end until all blocks are closed.
          if (currentMessageId) {
            pendingMessageEnd = v2('message_end', {
              messageId: currentMessageId,
              ...(msg.session_id ? { sessionId: msg.session_id } : {}),
            });
            tryFlushMessageEnd(currentSession);
          }
          // Capture session ID on first assistant event.
          if (!currentSession.sessionId && msg.session_id) {
            resolvedSessionId = msg.session_id as string;
            flushPreSessionBuffer();
            span.setAttribute('session.id', resolvedSessionId);
            registry.setSessionId(clientId, resolvedSessionId);
            onSessionResolved?.(resolvedSessionId);
            emit({ type: 'session_id', sessionId: msg.session_id });
            // Update session index with SDK session ID
            if (currentSession.wtId) {
              try {
                const repoPath = process.env.REPO_PATH || '';
                updateSessionSdkId(repoPath, currentSession.wtId, resolvedSessionId);
              } catch {
                // best-effort — session index write failure is non-fatal
              }
            }
            // Persist session metadata (including initial prompt) to durable store
            if (store) {
              store.upsertSession({
                sessionId: resolvedSessionId,
                cwd: currentSession.cwd,
                mode: currentSession.mode,
                branch: currentSession.branch,
                ...(currentSession.worktreePath ? { wtId: currentSession.wtId } : {}),
                ...(initialPrompt ? { initialPrompt } : {}),
              });
              if (initialPrompt) {
                // Store the initial prompt as a user_message event so
                // extractRecentPrompts() can find it for auto-rename.
                const now = Date.now();
                store.append(resolvedSessionId, 'user_message', {
                  v: 2,
                  type: 'user_message',
                  ts: now,
                  messageId: `umsg-${now}-init`,
                  text: initialPrompt,
                });
                // Trigger auto-rename — tryAutoRename handles the increment
                onInitialPrompt?.(resolvedSessionId);
              }
            }

            // Auto-create goal in ContexGin Goal Registry (awaited at session end)
            if (initialPrompt && resolvedSessionId) {
              goalTitle = deriveGoalTitle(initialPrompt);
              goalCreationPromise = createGoal(goalTitle, {
                description: initialPrompt.length > 80 ? initialPrompt.slice(0, 500) : undefined,
              }).catch((err: unknown) => {
                log.warn('goal creation promise rejected', {
                  error: err instanceof Error ? err.message : String(err),
                });
                return null;
              });
            }
          }
        } else if (msg.type === 'result') {
          log.info('result received', { clientId, sessionId: msg.session_id });
          // Capture snapshot blocks before flush (forceFlush nulls the snapshot).
          const snapshotBlocks = currentSession.currentSnapshot?.blocks ?? [];
          forceFlushPendingMessage(currentSession);
          doneSent = true;

          // Extract usage data from SDK result event
          const result = msg as SdkResultEvent;
          const usageData = {
            inputTokens: result.usage?.input_tokens ?? 0,
            outputTokens: result.usage?.output_tokens ?? 0,
            cacheReadTokens: result.usage?.cache_read_input_tokens ?? 0,
            cacheCreationTokens: result.usage?.cache_creation_input_tokens ?? 0,
            totalCostUsd: result.total_cost_usd ?? 0,
            numTurns: result.num_turns ?? 0,
            durationMs: result.duration_ms ?? 0,
            durationApiMs: result.duration_api_ms ?? 0,
          };

          // Persist usage to durable store
          if (store && resolvedSessionId) {
            store.recordUsage(resolvedSessionId, usageData);
          }

          const sdkTokens =
            usageData.inputTokens +
            usageData.outputTokens +
            usageData.cacheReadTokens +
            usageData.cacheCreationTokens;
          // Use the higher of SDK's reported total and our live tally
          // (SDK may undercount if sub-agent tokens aren't included in result.usage)
          currentSession.cumulativeSessionTokens = Math.max(sdkTokens, liveSessionTokens);
          currentSession.cumulativeCostUsd = usageData.totalCostUsd;

          emit({
            type: 'token_update',
            agentContext: agentContextTokens,
            contextCeiling: CONTEXT_CEILING_TOKENS,
            sessionTotal: currentSession.cumulativeSessionTokens,
            numTurns: usageData.numTurns,
            turnIndex,
            ...compactionFields(),
          });

          // Resolve goal creation (if pending) and report usage
          if (goalCreationPromise && resolvedSessionId) {
            const goalId = await goalCreationPromise;
            if (goalId) {
              resolvedGoalId = goalId;
              store?.upsertSession({ sessionId: resolvedSessionId, goalId });
              log.info('session linked to goal', { sessionId: resolvedSessionId, goalId });
            }
            goalCreationPromise = undefined;
          }

          if (resolvedGoalId && resolvedSessionId) {
            // Compute deltas to avoid double-counting in multi-turn sessions
            const deltaUsage = {
              inputTokens: usageData.inputTokens - lastReportedUsage.inputTokens,
              outputTokens: usageData.outputTokens - lastReportedUsage.outputTokens,
              cacheReadTokens: usageData.cacheReadTokens - lastReportedUsage.cacheReadTokens,
              cacheCreationTokens:
                usageData.cacheCreationTokens - lastReportedUsage.cacheCreationTokens,
              costUsd: usageData.totalCostUsd - lastReportedUsage.totalCostUsd,
              turns: usageData.numTurns - lastReportedUsage.numTurns,
              durationMs: usageData.durationMs - lastReportedUsage.durationMs,
              durationApiMs: usageData.durationApiMs - lastReportedUsage.durationApiMs,
            };
            lastReportedUsage = { ...usageData };

            reportUsage(resolvedGoalId, {
              source: 'mitzo_session',
              sourceId: resolvedSessionId,
              sourceLabel: initialPrompt
                ? `Mitzo: ${goalTitle ?? deriveGoalTitle(initialPrompt)}`
                : `Mitzo session ${resolvedSessionId}`,
              ...deltaUsage,
              metadata: {
                cwd: currentSession.cwd,
                mode: currentSession.mode,
              },
            });
          }

          span.setAttribute('session.num_turns', usageData.numTurns);
          span.setAttribute('session.total_tokens', currentSession.cumulativeSessionTokens);
          span.setAttribute('session.duration_ms', usageData.durationMs);
          span.setAttribute('session.cost_usd', usageData.totalCostUsd);
          emit(v2('session_end', { sessionId: msg.session_id, usage: usageData }));
          const resultSid = (msg.session_id as string) || currentSession.sessionId;
          if (resultSid && connRegistry?.hasOpenWatchers(resultSid)) {
            for (const { connectionId: cid } of connRegistry.getConnectionsWatching(
              resultSid,
              true,
            )) {
              const conn = connRegistry.get(cid);
              if (conn?.activeSession === resultSid) {
                connRegistry.setActive(cid, null);
              }
            }
          }
          if (!registry.isAttached(clientId)) {
            const snippet = extractSnippet(snapshotBlocks, NOTIFY_SNIPPET_MAX_CHARS);
            const sid = (msg.session_id as string) || currentSession.sessionId;
            ntfyTurnComplete(sid, snippet).catch(() => {});
            pushoverTurnComplete(sid, snippet).catch(() => {});
            apnsTurnComplete(sid, snippet).catch(() => {});
          }
        } else if (msg.type === 'stream_event') {
          const evt = msg.event as Record<string, unknown> | undefined;
          log.debug('stream event', { clientId, evtType: evt?.type });

          if (evt?.type === 'message_start') {
            // End previous turn span if still open (e.g. deferred message_end)
            if (currentTurnSpan) {
              currentTurnSpan.setAttribute('turn.block_count', turnBlockCount);
              currentTurnSpan.setStatus({ code: SpanStatusCode.OK });
              currentTurnSpan.end();
              currentTurnSpan = null;
            }
            forceFlushPendingMessage(currentSession);
            toolInputBuffers.clear();
            blockIdByIndex.clear();
            progressTracker.reset();
            blockCounter = 0;
            openBlockCount = 0;
            turnBlockCount = 0;
            const apiMsg = evt.message as Record<string, unknown> | undefined;
            currentMessageId = (apiMsg?.id as string | undefined) ?? `msg-${Date.now()}`;
            currentSession.currentSnapshot = { messageId: currentMessageId, blocks: [] };

            // Start turn child span under the session span
            currentTurnSpan = tracer.startSpan('turn', {}, context.active());
            currentTurnSpan.setAttribute('turn.index', turnIndex);
            currentTurnSpan.setAttribute('turn.message_id', currentMessageId);

            emit(v2('message_start', { messageId: currentMessageId }));

            // Extract agent context from message_start usage.
            // Only track parent agent (parent_tool_use_id === null) — sub-agent
            // context windows are independent and shouldn't overwrite the parent gauge.
            // Sum input + cache_read + cache_creation for the true context window size
            // (with prompt caching, input_tokens alone can be as low as 1).
            const isParent =
              msg.parent_tool_use_id === null || msg.parent_tool_use_id === undefined;
            const msgUsage = (apiMsg as Record<string, unknown> | undefined)?.usage as
              | Record<string, number>
              | undefined;
            const msgInput = msgUsage ? (msgUsage.input_tokens ?? 0) : 0;
            const msgCacheRead = msgUsage ? (msgUsage.cache_read_input_tokens ?? 0) : 0;
            const msgCacheCreation = msgUsage ? (msgUsage.cache_creation_input_tokens ?? 0) : 0;
            const msgOutput = msgUsage ? (msgUsage.output_tokens ?? 0) : 0;
            // Input/cache tokens are cumulative (each API call re-sends the full
            // conversation), so take the latest value instead of summing.
            // Output tokens are fresh per call, so accumulate them.
            const msgContext = msgInput + msgCacheRead + msgCacheCreation;
            if (msgOutput > 0) cumulativeOutputTokens += msgOutput;
            if (msgContext > 0 || msgOutput > 0) {
              liveSessionTokens = msgContext + cumulativeOutputTokens;
            }

            if (isParent && msgUsage) {
              const totalContext = msgInput + msgCacheRead + msgCacheCreation;
              if (totalContext > 0) {
                agentContextTokens = totalContext;
                turnIndex++;
                emit({
                  type: 'token_update',
                  agentContext: agentContextTokens,
                  contextCeiling: CONTEXT_CEILING_TOKENS,
                  turnIndex,
                  ...compactionFields(),
                });
              }
            }
          } else if (evt?.type === 'content_block_start') {
            // Auto-init message context if SDK delivers blocks before message_start.
            // On the first turn, AssistantMessage can win the async iterator race
            // and the first content_block_start arrives before message_start.
            if (!currentMessageId) {
              currentMessageId = `msg-${Date.now()}`;
              currentSession.currentSnapshot = { messageId: currentMessageId, blocks: [] };
              emit(v2('message_start', { messageId: currentMessageId }));
            }
            const contentBlock = evt.content_block as Record<string, unknown> | undefined;
            const index = evt.index as number;
            const blockId = nextBlockId();
            blockIdByIndex.set(index, blockId);
            openBlockCount++;

            const blockType = contentBlock?.type as string | undefined;
            log.debug('content block start', { clientId, blockType });

            if (blockType === 'thinking' || blockType === 'redacted_thinking') {
              log.info('thinking block detected', { clientId, blockType });
              const snapshotBlock: SnapshotBlock = {
                blockId,
                blockType: blockType as 'thinking' | 'redacted_thinking',
                content: '',
                done: false,
              };
              currentSession.currentSnapshot?.blocks.push(snapshotBlock);
              emit(
                v2('block_start', {
                  messageId: currentMessageId,
                  blockId,
                  blockType,
                }),
              );
            } else if (blockType === 'tool_use') {
              const toolName = contentBlock!.name as string;
              const toolId = contentBlock!.id as string;
              toolInputBuffers.set(index, { name: toolName, id: toolId, inputBuf: '', blockId });
              const snapshotBlock: SnapshotBlock = {
                blockId,
                blockType: 'tool_use',
                content: '',
                done: false,
                toolName,
                toolId,
              };
              currentSession.currentSnapshot?.blocks.push(snapshotBlock);

              // Start tool child span under the current turn span
              const toolParent = currentTurnSpan
                ? trace.setSpan(context.active(), currentTurnSpan)
                : context.active();
              const toolSpan = tracer.startSpan(`tool.${toolName}`, {}, toolParent);
              toolSpan.setAttribute('tool.name', toolName);
              toolSpan.setAttribute('tool.id', toolId);
              toolSpans.set(blockId, toolSpan);

              emit(
                v2('block_start', {
                  messageId: currentMessageId,
                  blockId,
                  blockType: 'tool_use',
                  toolName,
                }),
              );
            } else if (blockType === 'text') {
              const snapshotBlock: SnapshotBlock = {
                blockId,
                blockType: 'text',
                content: '',
                done: false,
              };
              currentSession.currentSnapshot?.blocks.push(snapshotBlock);
              emit(
                v2('block_start', {
                  messageId: currentMessageId,
                  blockId,
                  blockType: 'text',
                }),
              );
            }
          } else if (evt?.type === 'content_block_delta') {
            const delta = evt.delta as Record<string, unknown> | undefined;
            const index = evt.index as number;
            const blockId = blockIdByIndex.get(index);

            if (delta?.type === 'text_delta' && blockId) {
              const text = delta.text as string;
              // Update snapshot
              const block = currentSession.currentSnapshot?.blocks.find(
                (b) => b.blockId === blockId,
              );
              if (block) block.content += text;
              emit(
                v2('block_delta', {
                  messageId: currentMessageId,
                  blockId,
                  blockType: 'text',
                  delta: text,
                }),
              );
            } else if (delta?.type === 'thinking_delta' && blockId) {
              log.debug('thinking delta', { clientId });
              const text = delta.thinking as string;
              const block = currentSession.currentSnapshot?.blocks.find(
                (b) => b.blockId === blockId,
              );
              if (block) block.content += text;
              emit(
                v2('block_delta', {
                  messageId: currentMessageId,
                  blockId,
                  blockType: 'thinking',
                  delta: text,
                }),
              );
            } else if (delta?.type === 'input_json_delta') {
              const entry = toolInputBuffers.get(index);
              if (entry) entry.inputBuf += delta.partial_json as string;
            }
          } else if (evt?.type === 'content_block_stop') {
            const index = evt.index as number;
            const blockId = blockIdByIndex.get(index);
            const toolEntry = toolInputBuffers.get(index);

            if (toolEntry && blockId) {
              toolInputBuffers.delete(index);
              let toolInput: Record<string, unknown> = {};
              try {
                toolInput = JSON.parse(toolEntry.inputBuf || '{}');
              } catch {
                // malformed JSON — use empty input
              }
              const summarized = summarizeToolInput(toolEntry.name, toolInput);
              const rawInput = getRawInput(toolEntry.name, toolInput);

              const trInput = truncateForTrace(toolEntry.inputBuf);
              log.info('tool call', { clientId, tool: toolEntry.name, toolId: toolEntry.id });
              log.debug('tool call input', { clientId, toolId: toolEntry.id, input: trInput.text });

              // End tool span — record raw input before closing
              const toolSpan = toolSpans.get(blockId);
              if (toolSpan) {
                toolSpan.addEvent('tool.input', {
                  'tool.name': toolEntry.name,
                  'tool.input': trInput.text,
                  ...(trInput.truncated ? { 'tool.input.truncated': true } : {}),
                });
                toolSpan.setStatus({ code: SpanStatusCode.OK });
                toolSpan.end();
                toolSpans.delete(blockId);
              }

              // Mark snapshot block done with tool metadata.
              const block = currentSession.currentSnapshot?.blocks.find(
                (b) => b.blockId === blockId,
              );
              if (block) {
                block.done = true;
                block.toolInput = summarized;
                block.rawInput = rawInput;
              }

              emit(
                v2('block_end', {
                  messageId: currentMessageId,
                  blockId,
                  blockType: 'tool_use',
                  toolName: toolEntry.name,
                  toolId: toolEntry.id,
                  input: summarized,
                  ...(rawInput ? { rawInput } : {}),
                }),
              );

              // Intercept TodoWrite — emit structured progress events
              if (toolEntry.name === 'TodoWrite' && currentMessageId) {
                const progressEvents = progressTracker.handleTodoWrite(
                  currentMessageId,
                  toolEntry.id,
                  toolEntry.inputBuf,
                );
                for (const pe of progressEvents) {
                  emit(pe);
                }
              }
            } else if (blockId) {
              // Text or thinking block — mark done in snapshot, record in traces + logs.
              const block = currentSession.currentSnapshot?.blocks.find(
                (b) => b.blockId === blockId,
              );
              if (block) {
                const bt = block.blockType;
                block.done = true;

                // Record content in turn span and logs
                if (block.content && (bt === 'thinking' || bt === 'text')) {
                  const tr = truncateForTrace(block.content);
                  if (currentTurnSpan) {
                    currentTurnSpan.addEvent(`block.${bt}`, {
                      'block.id': blockId,
                      'block.content': tr.text,
                      ...(tr.truncated ? { 'block.truncated': true } : {}),
                    });
                  }
                  log.info(`${bt} block complete`, {
                    clientId,
                    blockId,
                    blockType: bt,
                    contentLength: block.content.length,
                  });
                  log.debug(`${bt} block content`, { clientId, blockId, content: tr.text });
                }

                emit(
                  v2('block_end', {
                    messageId: currentMessageId,
                    blockId,
                    blockType: bt,
                  }),
                );
              }
            }
            openBlockCount = Math.max(0, openBlockCount - 1);
            turnBlockCount++;
            tryFlushMessageEnd(currentSession);
          }
        } else if (msg.type === 'system') {
          // Track compaction events from SDK system status messages
          const subtype = (msg as Record<string, unknown>).subtype;
          const compactResult = (msg as Record<string, unknown>).compact_result;
          if (subtype === 'status' && compactResult === 'success') {
            numCompactions++;
            log.info('compaction completed', { clientId, numCompactions });
          }
        } else if (msg.type === 'user') {
          // Only extract tool_result events from SDK user turns.
          // Do NOT emit user_message here — human input is persisted at the
          // entry points (startChat, sendToChat, interruptChat) via PR #100.
          // Emitting user_message from the SDK stream would capture internal
          // API conversation turns (agent sub-prompts, tool-result text) and
          // replay them as user bubbles on session rejoin.
          const content = (msg.message as unknown as Record<string, unknown>)?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_result') {
                const resultText = extractToolResultText(block.content);
                const trResult = truncateForTrace(resultText);

                // Record tool result in session span and logs
                span.addEvent('tool.result', {
                  'tool.id': block.tool_use_id || '',
                  'tool.result': trResult.text,
                  'tool.is_error': block.is_error === true,
                  ...(trResult.truncated ? { 'tool.result.truncated': true } : {}),
                });
                log.info('tool result', {
                  clientId,
                  toolId: block.tool_use_id || '',
                  isError: block.is_error === true,
                  resultLength: resultText.length,
                });
                log.debug('tool result content', {
                  clientId,
                  toolId: block.tool_use_id || '',
                  result: trResult.text,
                });

                emit(
                  v2('tool_result', {
                    messageId: currentMessageId,
                    toolId: block.tool_use_id || '',
                    result: resultText.slice(0, TOOL_RESULT_MAX_CHARS),
                    isError: block.is_error === true,
                  }),
                );
              }
            }
          }
        }
      }
    } catch (err: unknown) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : 'unknown',
      });
      const currentSession = registry.get(clientId);
      if (currentSession) {
        if (timedOut) {
          const seconds = Math.round(QUERY_FIRST_EVENT_TIMEOUT_MS / 1000);
          const message = `Agent did not respond within ${seconds}s — the selected model may be unavailable on this provider.`;
          log.warn('query loop timed out waiting for first event', { clientId, seconds });
          send(currentSession.transport, { type: 'error', error: message });
        } else if (!abortController.signal.aborted) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          log.warn('query loop error', { clientId, error: message });
          send(currentSession.transport, { type: 'error', error: message });
        }
      }
    } finally {
      clearTimeout(firstEventTimer);
      const finalSession = registry.get(clientId);
      if (finalSession) {
        finalSession.currentSnapshot = null;
        if (!doneSent) {
          // Use sendOrBuffer to persist to EventStore (not just send) so that
          // reconnect replay includes session_end and clears stale running state.
          const sid = finalSession.sessionId ?? resolvedSessionId;
          const endMsg = v2('session_end', { sessionId: sid });
          sendOrBuffer(endMsg, clientId, registry, store, sid, connRegistry);
          if (sid && connRegistry?.hasOpenWatchers(sid)) {
            // Clear active session only on connections whose active is this session
            for (const { connectionId: cid } of connRegistry.getConnectionsWatching(sid, true)) {
              const conn = connRegistry.get(cid);
              if (conn?.activeSession === sid) {
                connRegistry.setActive(cid, null);
              }
            }
          }
        }
        registry.remove(clientId);
      }
      // Mark session as inactive in durable store
      if (store && resolvedSessionId) {
        store.markSessionInactive(resolvedSessionId);
      }
      // Clean up any open tool spans
      for (const [, ts] of toolSpans) {
        ts.setStatus({ code: SpanStatusCode.OK });
        ts.end();
      }
      toolSpans.clear();
      // Clean up open turn span
      if (currentTurnSpan) {
        currentTurnSpan.setAttribute('turn.block_count', turnBlockCount);
        currentTurnSpan.setStatus({ code: SpanStatusCode.OK });
        currentTurnSpan.end();
        currentTurnSpan = null;
      }

      span.setStatus({ code: SpanStatusCode.OK });
      log.info('query loop ended', { clientId, doneSent });
    }
  } finally {
    span.end();
  }
}
