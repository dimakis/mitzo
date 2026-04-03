import type { WebSocket } from 'ws';
import { resolvePending } from './permissions.js';
import { summarizeToolInput, getRawInput } from './tool-summary.js';
import { extractToolResultText } from './content-blocks.js';
import { TOOL_RESULT_MAX_CHARS } from './constants.js';
import { createLogger } from './logger.js';
import type { SessionRegistry, SnapshotBlock } from './session-registry.js';
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
 * Send a message to the client, or buffer it if the session is detached.
 * This prevents message loss during mid-session disconnects.
 */
function sendOrBuffer(ws: WebSocket, data: unknown, clientId: string, registry: SessionRegistry) {
  if (registry.isAttached(clientId)) {
    send(ws, data);
  } else {
    registry.bufferDetached(clientId, data);
  }
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
) {
  // Tool input buffers keyed by content block index (reset per message_start).
  const toolInputBuffers = new Map<
    number,
    { name: string; id: string; inputBuf: string; blockId: string }
  >();

  // Map content block index → blockId for all block types.
  const blockIdByIndex = new Map<number, string>();

  let blockCounter = 0;
  let currentMessageId: string | null = null;
  let doneSent = false;
  let openBlockCount = 0;
  let pendingMessageEnd: Record<string, unknown> | null = null;

  function nextBlockId(): string {
    return `b${blockCounter++}`;
  }

  function tryFlushMessageEnd(ws: WebSocket, session: { currentSnapshot: unknown | null }) {
    if (pendingMessageEnd && openBlockCount === 0) {
      sendOrBuffer(ws, pendingMessageEnd, clientId, registry);
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
          sendOrBuffer(
            ws,
            v2('block_end', {
              messageId: currentMessageId,
              blockId: bid,
              blockType: 'tool_use',
              toolName: toolEntry.name,
              toolId: toolEntry.id,
              input: summarizeToolInput(toolEntry.name, toolInput),
            }),
            clientId,
            registry,
          );
        } else {
          sendOrBuffer(
            ws,
            v2('block_end', {
              messageId: currentMessageId,
              blockId: bid,
              blockType: snap.blockType,
            }),
            clientId,
            registry,
          );
        }
        openBlockCount = Math.max(0, openBlockCount - 1);
      }
    }
    sendOrBuffer(ws, pendingMessageEnd, clientId, registry);
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
          registry.setSessionId(clientId, msg.session_id as string);
          sendOrBuffer(
            currentWs,
            { type: 'session_id', sessionId: msg.session_id },
            clientId,
            registry,
          );
        }
      } else if (msg.type === 'result') {
        log.info('result received', { clientId, sessionId: msg.session_id });
        // Capture snapshot blocks before flush (forceFlush nulls the snapshot).
        const snapshotBlocks = currentSession.currentSnapshot?.blocks ?? [];
        if (msg.session_id)
          sendOrBuffer(
            currentWs,
            { type: 'session_id', sessionId: msg.session_id },
            clientId,
            registry,
          );
        forceFlushPendingMessage(currentWs, currentSession);
        doneSent = true;
        sendOrBuffer(
          currentWs,
          v2('session_end', { sessionId: msg.session_id }),
          clientId,
          registry,
        );
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
          sendOrBuffer(
            currentWs,
            v2('message_start', { messageId: currentMessageId }),
            clientId,
            registry,
          );
        } else if (evt?.type === 'content_block_start') {
          // Auto-init message context if SDK delivers blocks before message_start.
          // On the first turn, AssistantMessage can win the async iterator race
          // and the first content_block_start arrives before message_start.
          if (!currentMessageId) {
            currentMessageId = `msg-${Date.now()}`;
            currentSession.currentSnapshot = { messageId: currentMessageId, blocks: [] };
            sendOrBuffer(
              currentWs,
              v2('message_start', { messageId: currentMessageId }),
              clientId,
              registry,
            );
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
            sendOrBuffer(
              currentWs,
              v2('block_start', {
                messageId: currentMessageId,
                blockId,
                blockType,
              }),
              clientId,
              registry,
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
            sendOrBuffer(
              currentWs,
              v2('block_start', {
                messageId: currentMessageId,
                blockId,
                blockType: 'tool_use',
                toolName: contentBlock!.name as string,
              }),
              clientId,
              registry,
            );
          } else if (blockType === 'text') {
            const snapshotBlock: SnapshotBlock = {
              blockId,
              blockType: 'text',
              content: '',
              done: false,
            };
            currentSession.currentSnapshot?.blocks.push(snapshotBlock);
            sendOrBuffer(
              currentWs,
              v2('block_start', {
                messageId: currentMessageId,
                blockId,
                blockType: 'text',
              }),
              clientId,
              registry,
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
            sendOrBuffer(
              currentWs,
              v2('block_delta', {
                messageId: currentMessageId,
                blockId,
                blockType: 'text',
                delta: text,
              }),
              clientId,
              registry,
            );
          } else if (delta?.type === 'thinking_delta' && blockId) {
            log.debug('thinking delta', { clientId });
            const text = delta.thinking as string;
            const block = currentSession.currentSnapshot?.blocks.find((b) => b.blockId === blockId);
            if (block) block.content += text;
            sendOrBuffer(
              currentWs,
              v2('block_delta', {
                messageId: currentMessageId,
                blockId,
                blockType: 'thinking',
                delta: text,
              }),
              clientId,
              registry,
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

            sendOrBuffer(
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
              clientId,
              registry,
            );
          } else if (blockId) {
            // Text or thinking block — mark done in snapshot.
            const block = currentSession.currentSnapshot?.blocks.find((b) => b.blockId === blockId);
            if (block) {
              const bt = block.blockType;
              block.done = true;
              sendOrBuffer(
                currentWs,
                v2('block_end', {
                  messageId: currentMessageId,
                  blockId,
                  blockType: bt,
                }),
                clientId,
                registry,
              );
            }
          }
          openBlockCount = Math.max(0, openBlockCount - 1);
          tryFlushMessageEnd(currentWs, currentSession);
        }
      } else if (msg.type === 'user') {
        // Tool results injected by the SDK after tool execution.
        const content = (msg.message as unknown as Record<string, unknown>)?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              const resultText = extractToolResultText(block.content);
              sendOrBuffer(
                currentWs,
                v2('tool_result', {
                  messageId: currentMessageId,
                  toolId: block.tool_use_id || '',
                  result: resultText.slice(0, TOOL_RESULT_MAX_CHARS),
                  isError: block.is_error === true,
                }),
                clientId,
                registry,
              );
            }
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
    log.info('query loop ended', { clientId, doneSent });
  }
}
