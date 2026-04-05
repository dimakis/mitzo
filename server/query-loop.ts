import type { WebSocket } from 'ws';
import { resolvePending } from './permissions.js';
import { summarizeToolInput, getRawInput } from './tool-summary.js';
import { extractToolResultText } from './content-blocks.js';
import { TOOL_RESULT_MAX_CHARS } from './constants.js';
import { createLogger } from './logger.js';
import type { SessionRegistry, SnapshotBlock } from './session-registry.js';
import type { EventStore } from './event-store.js';
import { sendTurnCompleteNotification as ntfyTurnComplete } from './notify.js';
import { sendTurnCompleteNotification as pushoverTurnComplete } from './pushover.js';
import { extractSnippet } from './notification-helpers.js';
import { NOTIFY_SNIPPET_MAX_CHARS } from './constants.js';
import { PermissionResponseMessage, SetModeMessage } from './ws-schemas.js';

const log = createLogger('query-loop');

function send(ws: WebSocket, data: unknown) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

/**
 * Persist a v2 event to the durable store (if available), then send or buffer.
 * The store.append() is synchronous and happens before WS delivery,
 * so events survive even if the connection drops mid-send.
 */
function sendOrBuffer(
  ws: WebSocket,
  data: Record<string, unknown>,
  clientId: string,
  registry: SessionRegistry,
  store?: EventStore,
  sessionId?: string,
) {
  let enriched: Record<string, unknown> = data;
  if (store && sessionId && data.v === 2) {
    const seq = store.append(sessionId, data.type as string, data);
    enriched = { ...data, seq };
  }
  if (registry.isAttached(clientId)) {
    send(ws, enriched);
  }
  // When detached, messages are dropped — recovery via event store replay on reattach.
}

function v2(type: string, rest: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 2, type, ts: Date.now(), ...rest };
}

export function createWsMessageHandler(clientId: string, registry: SessionRegistry) {
  return (raw: Buffer) => {
    try {
      const parsed = JSON.parse(raw.toString());
      const permResult = PermissionResponseMessage.safeParse(parsed);
      if (permResult.success) {
        resolvePending(permResult.data.permId, permResult.data.decision || 'deny');
        return;
      }
      const modeResult = SetModeMessage.safeParse(parsed);
      if (modeResult.success) {
        registry.setMode(clientId, modeResult.data.mode);
        const session = registry.get(clientId);
        if (session) send(session.ws, { type: 'mode_changed', mode: modeResult.data.mode });
      }
    } catch (err: unknown) {
      log.warn('malformed WS message from client', {
        clientId,
        error: err instanceof Error ? err.message : 'parse failure',
      });
    }
  };
}

export async function runQueryLoop(
  q: AsyncIterable<Record<string, unknown>>,
  clientId: string,
  registry: SessionRegistry,
  abortController: AbortController,
  _ws: WebSocket,
  store?: EventStore,
  initialPrompt?: string,
) {
  // Tool input buffers keyed by content block index (reset per message_start).
  const toolInputBuffers = new Map<
    number,
    { name: string; id: string; inputBuf: string; blockId: string }
  >();

  // Map content block index → blockId for all block types.
  const blockIdByIndex = new Map<number, string>();

  let blockCounter = 0;
  let userMsgCounter = 0;
  let currentMessageId: string | null = null;
  let doneSent = false;
  let openBlockCount = 0;
  let pendingMessageEnd: Record<string, unknown> | null = null;
  let resolvedSessionId: string | undefined;

  /** Wrapper that auto-injects store + sessionId into sendOrBuffer */
  function emit(ws: WebSocket, data: Record<string, unknown>) {
    sendOrBuffer(ws, data, clientId, registry, store, resolvedSessionId);
  }

  function nextBlockId(): string {
    return `b${blockCounter++}`;
  }

  function tryFlushMessageEnd(ws: WebSocket, session: { currentSnapshot: unknown | null }) {
    if (pendingMessageEnd && openBlockCount === 0) {
      emit(ws, pendingMessageEnd);
      pendingMessageEnd = null;
      currentMessageId = null;
      (session as { currentSnapshot: null }).currentSnapshot = null;
    }
  }

  function forceFlushPendingMessage(
    ws: WebSocket,
    session: { currentSnapshot: { blocks: SnapshotBlock[] } | null },
  ) {
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
            ws,
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
            ws,
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
    emit(ws, pendingMessageEnd);
    pendingMessageEnd = null;
    currentMessageId = null;
    session.currentSnapshot = null;
  }

  log.info('query loop started', { clientId });

  try {
    for await (const msg of q) {
      const currentSession = registry.get(clientId);
      if (!currentSession) break;
      const currentWs = currentSession.ws;
      if (!resolvedSessionId && currentSession.sessionId) {
        resolvedSessionId = currentSession.sessionId;
      }

      log.debug('sdk event', { clientId, type: msg.type });

      if (msg.type === 'assistant') {
        // Turn complete — defer message_end until all blocks are closed.
        if (currentMessageId) {
          pendingMessageEnd = v2('message_end', {
            messageId: currentMessageId,
            ...(msg.session_id ? { sessionId: msg.session_id } : {}),
          });
          tryFlushMessageEnd(currentWs, currentSession);
        }
        // Capture session ID on first assistant event.
        if (!currentSession.sessionId && msg.session_id) {
          resolvedSessionId = msg.session_id as string;
          registry.setSessionId(clientId, resolvedSessionId);
          emit(currentWs, { type: 'session_id', sessionId: msg.session_id });
          // Persist session metadata to durable store
          if (store) {
            store.upsertSession({
              sessionId: resolvedSessionId,
              cwd: currentSession.cwd,
              mode: currentSession.mode,
            });
            // Persist the initial user prompt now that we have a sessionId
            if (initialPrompt) {
              emit(
                currentWs,
                v2('user_message', {
                  messageId: `umsg-${Date.now()}-${userMsgCounter++}`,
                  text: initialPrompt,
                }),
              );
            }
          }
        }
      } else if (msg.type === 'result') {
        log.info('result received', { clientId, sessionId: msg.session_id });
        // Capture snapshot blocks before flush (forceFlush nulls the snapshot).
        const snapshotBlocks = currentSession.currentSnapshot?.blocks ?? [];
        if (msg.session_id) emit(currentWs, { type: 'session_id', sessionId: msg.session_id });
        forceFlushPendingMessage(currentWs, currentSession);
        doneSent = true;
        emit(currentWs, v2('session_end', { sessionId: msg.session_id }));
        if (!registry.isAttached(clientId)) {
          const snippet = extractSnippet(snapshotBlocks, NOTIFY_SNIPPET_MAX_CHARS);
          const sid = (msg.session_id as string) || currentSession.sessionId;
          ntfyTurnComplete(sid, snippet).catch(() => {});
          pushoverTurnComplete(sid, snippet).catch(() => {});
        }
      } else if (msg.type === 'stream_event') {
        const evt = msg.event as Record<string, unknown> | undefined;
        log.debug('stream event', { clientId, evtType: evt?.type });

        if (evt?.type === 'message_start') {
          forceFlushPendingMessage(currentWs, currentSession);
          toolInputBuffers.clear();
          blockIdByIndex.clear();
          blockCounter = 0;
          openBlockCount = 0;
          // Use API message ID if available, otherwise generate one.
          const apiMsg = evt.message as Record<string, unknown> | undefined;
          currentMessageId = (apiMsg?.id as string | undefined) ?? `msg-${Date.now()}`;
          // Init snapshot on the session.
          currentSession.currentSnapshot = { messageId: currentMessageId, blocks: [] };
          emit(currentWs, v2('message_start', { messageId: currentMessageId }));
        } else if (evt?.type === 'content_block_start') {
          // Auto-init message context if SDK delivers blocks before message_start.
          // On the first turn, AssistantMessage can win the async iterator race
          // and the first content_block_start arrives before message_start.
          if (!currentMessageId) {
            currentMessageId = `msg-${Date.now()}`;
            currentSession.currentSnapshot = { messageId: currentMessageId, blocks: [] };
            emit(currentWs, v2('message_start', { messageId: currentMessageId }));
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
              currentWs,
              v2('block_start', {
                messageId: currentMessageId,
                blockId,
                blockType,
              }),
            );
          } else if (blockType === 'tool_use') {
            toolInputBuffers.set(index, {
              name: contentBlock!.name as string,
              id: contentBlock!.id as string,
              inputBuf: '',
              blockId,
            });
            const snapshotBlock: SnapshotBlock = {
              blockId,
              blockType: 'tool_use',
              content: '',
              done: false,
              toolName: contentBlock!.name as string,
              toolId: contentBlock!.id as string,
            };
            currentSession.currentSnapshot?.blocks.push(snapshotBlock);
            emit(
              currentWs,
              v2('block_start', {
                messageId: currentMessageId,
                blockId,
                blockType: 'tool_use',
                toolName: contentBlock!.name as string,
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
              currentWs,
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
            const block = currentSession.currentSnapshot?.blocks.find((b) => b.blockId === blockId);
            if (block) block.content += text;
            emit(
              currentWs,
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
            const block = currentSession.currentSnapshot?.blocks.find((b) => b.blockId === blockId);
            if (block) block.content += text;
            emit(
              currentWs,
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

            log.info('tool call', { clientId, tool: toolEntry.name, toolId: toolEntry.id });

            // Mark snapshot block done with tool metadata.
            const block = currentSession.currentSnapshot?.blocks.find((b) => b.blockId === blockId);
            if (block) {
              block.done = true;
              block.toolInput = summarized;
              block.rawInput = rawInput;
            }

            emit(
              currentWs,
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
          } else if (blockId) {
            // Text or thinking block — mark done in snapshot.
            const block = currentSession.currentSnapshot?.blocks.find((b) => b.blockId === blockId);
            if (block) {
              const bt = block.blockType;
              block.done = true;
              emit(
                currentWs,
                v2('block_end', {
                  messageId: currentMessageId,
                  blockId,
                  blockType: bt,
                }),
              );
            }
          }
          openBlockCount = Math.max(0, openBlockCount - 1);
          tryFlushMessageEnd(currentWs, currentSession);
        }
      } else if (msg.type === 'user') {
        const content = (msg.message as unknown as Record<string, unknown>)?.content;
        if (typeof content === 'string' && content) {
          emit(
            currentWs,
            v2('user_message', {
              messageId: `umsg-${Date.now()}-${userMsgCounter++}`,
              text: content,
            }),
          );
        } else if (Array.isArray(content)) {
          const textParts: string[] = [];
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              textParts.push(block.text as string);
            } else if (block.type === 'tool_result') {
              const resultText = extractToolResultText(block.content);
              emit(
                currentWs,
                v2('tool_result', {
                  messageId: currentMessageId,
                  toolId: block.tool_use_id || '',
                  result: resultText.slice(0, TOOL_RESULT_MAX_CHARS),
                  isError: block.is_error === true,
                }),
              );
            }
          }
          if (textParts.length > 0) {
            emit(
              currentWs,
              v2('user_message', {
                messageId: `umsg-${Date.now()}-${userMsgCounter++}`,
                text: textParts.join('\n\n'),
              }),
            );
          }
        }
      }
    }
  } catch (err: unknown) {
    const currentSession = registry.get(clientId);
    if (currentSession && !abortController.signal.aborted) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      log.warn('query loop error', { clientId, error: message });
      send(currentSession.ws, { type: 'error', error: message });
    }
  } finally {
    const finalSession = registry.get(clientId);
    if (finalSession) {
      finalSession.currentSnapshot = null;
      const finalWs = finalSession.ws;
      registry.remove(clientId);
      if (!doneSent && finalWs.readyState === finalWs.OPEN) {
        send(finalWs, v2('session_end', { sessionId: finalSession.sessionId }));
      }
    }
    // Mark session as inactive in durable store
    if (store && resolvedSessionId) {
      store.markSessionInactive(resolvedSessionId);
    }
    log.info('query loop ended', { clientId, doneSent });
  }
}
