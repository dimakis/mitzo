import { query, listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import type { WebSocket } from 'ws';
import { registerPending, resolvePending, removePending, hasPending } from './permissions.js';
import { sendPermissionNotification, isConfigured as ntfyConfigured } from './notify.js';
import { createWorktree, removeWorktree } from './worktree.js';

export const BASE_REPO = process.env.REPO_PATH || '';
const WORKTREE_ENABLED = process.env.WORKTREE_ENABLED !== 'false';

export type MitzoMode = 'ask' | 'agent' | 'auto';

const MODE_TO_SDK: Record<MitzoMode, string> = {
  ask: 'plan',
  agent: 'default',
  auto: 'bypassPermissions',
};

interface ActiveSession {
  queryInstance: any;
  abortController: AbortController;
  sessionId?: string;
  ws: WebSocket;
  sessionAllowList: Set<string>;
  mode: MitzoMode;
  worktreePath?: string;
}

const activeSessions = new Map<string, ActiveSession>();

const VENV_PATHS = [
  `${BASE_REPO}/jira_process/.venv/bin`,
  `${BASE_REPO}/team_home/.venv/bin`,
  `${BASE_REPO}/team_home/jira_process/.venv/bin`,
];

function sdkEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  env.CLAUDE_CODE_USE_VERTEX = process.env.CLAUDE_CODE_USE_VERTEX || '1';
  env.ANTHROPIC_VERTEX_PROJECT_ID = process.env.ANTHROPIC_VERTEX_PROJECT_ID || '';
  env.CLOUD_ML_REGION = process.env.CLOUD_ML_REGION || 'us-east5';

  const existingPath = env.PATH || '/usr/bin:/bin:/usr/local/bin';
  env.PATH = [...VENV_PATHS, existingPath].join(':');

  delete env.AUTH_PASSPHRASE;
  delete env.AUTH_SECRET;
  delete env.NTFY_AUTH_TOKEN;
  return env;
}

export const AVAILABLE_MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', desc: 'Balanced' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6', desc: 'Most capable' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', desc: 'Fastest' },
];

export async function startChat(
  ws: WebSocket,
  clientId: string,
  prompt: string,
  options: { resume?: string; cwd?: string; model?: string; extraTools?: string; mode?: MitzoMode; worktree?: boolean }
) {
  const abortController = new AbortController();
  const mode = options.mode || 'agent';
  const sessionAllowList = new Set<string>();

  let cwd = options.cwd || BASE_REPO;
  let worktreePath: string | undefined;

  const useWorktree = WORKTREE_ENABLED && options.worktree !== false
    && !options.cwd && !options.resume && BASE_REPO;

  if (useWorktree) {
    try {
      worktreePath = createWorktree(clientId, BASE_REPO);
      cwd = worktreePath;
      send(ws, { type: 'worktree', path: worktreePath });
    } catch (err: any) {
      console.error('[worktree] creation failed, using base repo:', err.message);
      send(ws, { type: 'error', error: `Worktree creation failed (using base repo): ${err.message}` });
    }
  }

  const baseAllowed = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
  const extraTools = options.extraTools ? options.extraTools.split(',').map(t => t.trim()) : [];

  const session: ActiveSession = { queryInstance: null, abortController, ws, sessionAllowList, mode, worktreePath };

  const q = query({
    prompt,
    options: {
      cwd,
      env: sdkEnv(),
      abortController,
      includePartialMessages: true,
      settingSources: ['project'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      permissionMode: MODE_TO_SDK[mode] as any,
      allowedTools: [...baseAllowed, ...extraTools],
      ...(options.model ? { model: options.model } : {}),
      ...(options.resume ? { resume: options.resume } : {}),
      canUseTool: async (toolName: string, toolInput: Record<string, unknown>, opts: any) => {
        if (session.mode === 'auto') {
          return { behavior: 'allow' as const };
        }

        if (sessionAllowList.has(toolName)) {
          return { behavior: 'allow' as const, decisionClassification: 'user_permanent' as const };
        }

        const inputSummary = summarizeToolInput(toolName, toolInput);

        return new Promise((resolve) => {
          const permId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

          const wrappedResolve = (result: any) => {
            if (result.behavior === 'allow' && result.decisionClassification === 'user_permanent') {
              sessionAllowList.add(toolName);
            }
            resolve(result);
          };

          registerPending(permId, toolName, wrappedResolve, opts?.suggestions);

          send(ws, {
            type: 'permission_request',
            permId,
            toolName,
            toolInput: inputSummary,
          });

          if (ntfyConfigured()) {
            setTimeout(() => {
              if (hasPending(permId)) {
                sendPermissionNotification(toolName, inputSummary, permId);
              }
            }, 10_000);
          }

          setTimeout(() => {
            if (hasPending(permId)) {
              removePending(permId);
              resolve({ behavior: 'deny' as const, message: 'Permission request timed out' });
              send(ws, { type: 'permission_timeout', permId });
            }
          }, 120_000);
        });
      },
    },
  });

  session.queryInstance = q;
  activeSessions.set(clientId, session);

  const messageHandler = (raw: any) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'permission_response' && msg.permId) {
        resolvePending(msg.permId, msg.decision || 'deny');
      } else if (msg.type === 'set_mode' && msg.mode) {
        session.mode = msg.mode;
        send(ws, { type: 'mode_changed', mode: msg.mode });
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
    if (session.worktreePath) {
      try { removeWorktree(clientId, BASE_REPO); } catch {}
    }
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
    if (session.worktreePath) {
      try { removeWorktree(clientId, BASE_REPO); } catch {}
    }
  }
}

export function isActive(clientId: string): boolean {
  return activeSessions.has(clientId);
}

export async function getSessions() {
  try {
    const sessions = await listSessions({ dir: BASE_REPO, limit: 20 });
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
    const messages = await getSessionMessages(sessionId, { dir: BASE_REPO, limit: 100 });
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
