import type { WebSocket } from 'ws';
import { resolvePending } from './permissions.js';
import { summarizeToolInput, getRawInput } from './tool-summary.js';
import { extractToolResultText } from './content-blocks.js';
import { TOOL_RESULT_MAX_CHARS } from './constants.js';
import { createLogger } from './logger.js';
import type { SessionRegistry } from './session-registry.js';

const log = createLogger('query-loop');

function send(ws: WebSocket, data: unknown) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

export function createWsMessageHandler(clientId: string, registry: SessionRegistry) {
  return (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'permission_response' && msg.permId) {
        resolvePending(msg.permId, msg.decision || 'deny');
      } else if (msg.type === 'set_mode' && msg.mode) {
        registry.setMode(clientId, msg.mode);
        const session = registry.get(clientId);
        if (session) send(session.ws, { type: 'mode_changed', mode: msg.mode });
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
  // Buffer tool_use blocks streamed via content_block_start/delta/stop events.
  // Keyed by content block index (resets per API message via message_start).
  const toolInputBuffers = new Map<number, { name: string; id: string; inputBuf: string }>();
  let doneSent = false;

  log.info('query loop started', { clientId });

  try {
    for await (const msg of q) {
      const currentSession = registry.get(clientId);
      if (!currentSession) break;
      const currentWs = currentSession.ws;

      log.debug('sdk event', { clientId, type: msg.type });

      if (msg.type === 'assistant') {
        // Text and tool_use blocks are already delivered via stream_event
        // (text_delta, content_block_stop). Re-sending text here would create
        // duplicate messages in the frontend, especially when tool calls
        // interleave between streaming and this finalization event.
        if (!currentSession.sessionId && msg.session_id) {
          registry.setSessionId(clientId, msg.session_id as string);
          send(currentWs, { type: 'session_id', sessionId: msg.session_id });
        }
      } else if (msg.type === 'result') {
        log.info('result received', { clientId, sessionId: msg.session_id });
        if (msg.session_id) send(currentWs, { type: 'session_id', sessionId: msg.session_id });
        doneSent = true;
        send(currentWs, { type: 'done', sessionId: msg.session_id });
      } else if (msg.type === 'stream_event') {
        const evt = msg.event as Record<string, unknown> | undefined;
        log.debug('stream event', { clientId, evtType: evt?.type });
        if (evt?.type === 'message_start') {
          toolInputBuffers.clear();
        } else if (evt?.type === 'content_block_start') {
          const contentBlock = evt.content_block as Record<string, unknown> | undefined;
          log.debug('content block start', { clientId, blockType: contentBlock?.type });
          if (contentBlock?.type === 'thinking') {
            log.info('thinking block detected', { clientId });
            send(currentWs, { type: 'thinking_start' });
          } else if (contentBlock?.type === 'tool_use') {
            toolInputBuffers.set(evt.index as number, {
              name: contentBlock.name as string,
              id: contentBlock.id as string,
              inputBuf: '',
            });
          }
        } else if (evt?.type === 'content_block_delta') {
          const delta = evt.delta as Record<string, unknown> | undefined;
          if (delta?.type === 'text_delta') {
            send(currentWs, { type: 'text_delta', text: delta.text });
          } else if (delta?.type === 'thinking_delta') {
            log.debug('thinking delta', { clientId });
            send(currentWs, { type: 'thinking_delta', text: delta.thinking });
          } else if (delta?.type === 'input_json_delta') {
            const entry = toolInputBuffers.get(evt.index as number);
            if (entry) entry.inputBuf += delta.partial_json as string;
          }
        } else if (evt?.type === 'content_block_stop') {
          const entry = toolInputBuffers.get(evt.index as number);
          if (entry) {
            toolInputBuffers.delete(evt.index as number);
            let toolInput: Record<string, unknown> = {};
            try {
              toolInput = JSON.parse(entry.inputBuf || '{}');
            } catch {
              // malformed JSON — use empty input
            }
            log.info('tool call', { clientId, tool: entry.name, toolId: entry.id });
            send(currentWs, {
              type: 'tool_call',
              toolName: entry.name,
              toolId: entry.id,
              input: summarizeToolInput(entry.name, toolInput),
              rawInput: getRawInput(entry.name, toolInput),
            });
          }
        }
      } else if (msg.type === 'user') {
        const content = (msg.message as unknown as Record<string, unknown>)?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              const resultText = extractToolResultText(block.content);
              send(currentWs, {
                type: 'tool_result',
                toolId: block.tool_use_id || '',
                result: resultText.slice(0, TOOL_RESULT_MAX_CHARS),
              });
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
      const finalWs = finalSession.ws;
      registry.remove(clientId);
      if (!doneSent && finalWs.readyState === finalWs.OPEN) {
        send(finalWs, { type: 'done', sessionId: finalSession.sessionId });
      }
    }
    log.info('query loop ended', { clientId, doneSent });
  }
}
