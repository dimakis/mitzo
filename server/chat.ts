import { query, listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import type { WebSocket } from 'ws';

const MGT_CWD = '/Users/dsaridak/redhat/mgmt';

interface ActiveSession {
  queryInstance: AsyncGenerator<any, void>;
  abortController: AbortController;
  sessionId?: string;
  ws: WebSocket;
}

const activeSessions = new Map<string, ActiveSession>();

function sdkEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  env.CLAUDE_CODE_USE_VERTEX = process.env.CLAUDE_CODE_USE_VERTEX || '1';
  env.ANTHROPIC_VERTEX_PROJECT_ID = process.env.ANTHROPIC_VERTEX_PROJECT_ID || '';
  env.CLOUD_ML_REGION = process.env.CLOUD_ML_REGION || 'us-east5';
  delete env.AUTH_PASSPHRASE;
  delete env.AUTH_SECRET;
  delete env.NTFY_AUTH_TOKEN;
  return env;
}

export async function startChat(
  ws: WebSocket,
  clientId: string,
  prompt: string,
  options: { resume?: string; cwd?: string }
) {
  const abortController = new AbortController();
  const cwd = options.cwd || MGT_CWD;
  const pendingPermissions = new Map<string, (result: { behavior: 'allow' } | { behavior: 'deny'; message: string }) => void>();

  const q = query({
    prompt,
    options: {
      cwd,
      env: sdkEnv(),
      abortController,
      includePartialMessages: true,
      settingSources: ['project'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      allowedTools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
      ...(options.resume ? { resume: options.resume } : {}),
      canUseTool: async (toolName, toolInput) => {
        return new Promise((resolve) => {
          const permId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          pendingPermissions.set(permId, resolve);

          send(ws, {
            type: 'permission_request',
            permId,
            toolName,
            toolInput: summarizeToolInput(toolName, toolInput),
          });

          setTimeout(() => {
            if (pendingPermissions.has(permId)) {
              pendingPermissions.delete(permId);
              resolve({ behavior: 'deny', message: 'Permission request timed out' });
              send(ws, { type: 'permission_timeout', permId });
            }
          }, 120_000);
        });
      },
    },
  });

  const session: ActiveSession = { queryInstance: q, abortController, ws };
  activeSessions.set(clientId, session);

  const messageHandler = (raw: any) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'permission_response' && msg.permId) {
        const resolver = pendingPermissions.get(msg.permId);
        if (resolver) {
          pendingPermissions.delete(msg.permId);
          resolver(msg.allowed
            ? { behavior: 'allow' as const }
            : { behavior: 'deny' as const, message: 'User denied' }
          );
        }
      }
    } catch {}
  };
  ws.on('message', messageHandler);

  try {
    for await (const msg of q) {
      if (ws.readyState !== ws.OPEN) break;

      if (msg.type === 'assistant') {
        if (msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text') {
              send(ws, { type: 'text', text: block.text });
            } else if (block.type === 'tool_use') {
              send(ws, {
                type: 'tool_call',
                toolName: block.name,
                toolId: block.id,
                input: summarizeToolInput(block.name, block.input as Record<string, unknown>),
              });
            }
          }
        }
        if (!session.sessionId && msg.session_id) {
          session.sessionId = msg.session_id;
          send(ws, { type: 'session_id', sessionId: msg.session_id });
        }
      } else if (msg.type === 'result') {
        if (msg.session_id) {
          send(ws, { type: 'session_id', sessionId: msg.session_id });
        }
        send(ws, { type: 'done', sessionId: msg.session_id });
      } else if (msg.type === 'stream_event') {
        const evt = msg.event;
        if (evt?.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          send(ws, { type: 'text_delta', text: evt.delta.text });
        }
      } else if (msg.type === 'user' && msg.tool_use_result !== undefined) {
        const content = (msg.message as any)?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              let resultText = '';
              if (typeof block.content === 'string') resultText = block.content;
              else if (Array.isArray(block.content)) {
                for (const c of block.content) {
                  if (c.type === 'text') resultText += c.text;
                }
              }
              send(ws, {
                type: 'tool_result',
                toolId: block.tool_use_id || '',
                result: resultText.slice(0, 2000),
              });
            }
          }
        }
      }
    }
  } catch (err: any) {
    if (!abortController.signal.aborted) {
      send(ws, { type: 'error', error: err.message || 'Unknown error' });
    }
  } finally {
    ws.removeListener('message', messageHandler);
    activeSessions.delete(clientId);
    if (ws.readyState === ws.OPEN) {
      send(ws, { type: 'done', sessionId: session.sessionId });
    }
  }
}

export function stopChat(clientId: string) {
  const session = activeSessions.get(clientId);
  if (session) {
    session.abortController.abort();
    activeSessions.delete(clientId);
  }
}

export function isActive(clientId: string): boolean {
  return activeSessions.has(clientId);
}

export async function getSessions() {
  try {
    const sessions = await listSessions({ dir: MGT_CWD, limit: 20 });
    return sessions.map(s => ({
      id: s.sessionId,
      summary: s.summary,
      lastModified: s.lastModified,
      branch: s.gitBranch,
    }));
  } catch {
    return [];
  }
}

export async function getMessages(sessionId: string) {
  try {
    const messages = await getSessionMessages(sessionId, { dir: MGT_CWD, limit: 100 });
    return messages.map(m => {
      const content = (m.message as any)?.content;
      let text = '';
      const toolCalls: any[] = [];
      const toolResults: any[] = [];

      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') text += block.text;
          else if (block.type === 'tool_use') {
            toolCalls.push({
              toolName: block.name,
              toolId: block.id,
              input: summarizeToolInput(block.name, block.input),
            });
          } else if (block.type === 'tool_result') {
            let rt = '';
            if (typeof block.content === 'string') rt = block.content;
            else if (Array.isArray(block.content)) {
              for (const c of block.content) { if (c.type === 'text') rt += c.text; }
            }
            toolResults.push({ toolId: block.tool_use_id, result: rt.slice(0, 2000) });
          }
        }
      }

      return {
        role: m.type,
        text: text || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        toolResults: toolResults.length > 0 ? toolResults : undefined,
      };
    }).filter(m => m.text || m.toolCalls || m.toolResults);
  } catch {
    return [];
  }
}

function send(ws: WebSocket, data: unknown) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Read': return `${input.path || ''}`;
    case 'Write': return `${input.path || ''} (${String(input.contents || '').length} chars)`;
    case 'Edit': case 'StrReplace': return `${input.path || ''}`;
    case 'Bash': return `${String(input.command || '').slice(0, 200)}`;
    case 'Glob': return `${input.glob_pattern || ''} in ${input.target_directory || 'workspace'}`;
    case 'Grep': return `/${input.pattern || ''}/ in ${input.path || 'workspace'}`;
    case 'WebSearch': return `${input.search_term || ''}`;
    case 'WebFetch': return `${input.url || ''}`;
    default: return JSON.stringify(input).slice(0, 200);
  }
}
