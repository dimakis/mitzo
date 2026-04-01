import {
  query,
  listSessions,
  getSessionMessages,
  type PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';
import type { WebSocket } from 'ws';
import { execFileSync } from 'child_process';
import { writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { registerPending, resolvePending, removePending, hasPending } from './permissions.js';
import { sendPermissionNotification, isConfigured as ntfyConfigured } from './notify.js';
import { createWorktree } from './worktree.js';
import { SessionRegistry, type MitzoMode } from './session-registry.js';
import { summarizeToolInput } from './tool-summary.js';
import { parseContentBlocks, extractToolResultText } from './content-blocks.js';
import { loadMcpServers, type McpServerConfig } from './mcp-config.js';
import { getToolTier, shouldAutoAllow, getAllowedToolsForMode } from './tool-tiers.js';
import { loadRepoConfig } from './repo-config.js';

export type { MitzoMode } from './session-registry.js';

let mcpServers: Record<string, McpServerConfig> = {};
try {
  mcpServers = loadMcpServers();
} catch (err: unknown) {
  console.error('[mcp] failed to load MCP servers:', err instanceof Error ? err.message : err);
}

export function getMcpServerNames(): string[] {
  return Object.keys(mcpServers);
}

export const BASE_REPO = process.env.REPO_PATH || '';
const WORKTREE_ENABLED = process.env.WORKTREE_ENABLED !== 'false';

const MODE_TO_SDK: Record<MitzoMode, string> = {
  ask: 'plan',
  agent: 'default',
  auto: 'acceptEdits',
};

export const registry = new SessionRegistry();

const repoConfig = loadRepoConfig(BASE_REPO);
export { repoConfig };

const VENV_PATHS = repoConfig.resolvedVenvPaths;

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

function send(ws: WebSocket, data: unknown) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function resolveWorktree(
  ws: WebSocket,
  baseCwd: string,
  options: { resume?: string; cwd?: string; worktree?: boolean },
): { cwd: string; worktreePath?: string } {
  if (
    !(WORKTREE_ENABLED && options.worktree === true && !options.cwd && !options.resume && BASE_REPO)
  ) {
    return { cwd: baseCwd };
  }
  const wtId = `wt-${Date.now().toString(36)}`;
  try {
    const worktreePath = createWorktree(wtId, BASE_REPO);
    send(ws, { type: 'worktree', path: worktreePath });
    return { cwd: worktreePath, worktreePath };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[worktree] creation failed, using base repo:', message);
    send(ws, { type: 'error', error: `Worktree creation failed (using base repo): ${message}` });
    return { cwd: baseCwd };
  }
}

/**
 * Allow all MCP tools via allowedTools. The SDK's canUseTool Zod validation
 * is incompatible with our permission response format for MCP tools.
 * Write protection is handled by the system prompt (HITL: Claude asks before
 * mutating) rather than the SDK permission system.
 */
function buildMcpAllowedTools(): string[] {
  return Object.keys(mcpServers).map((name) => `mcp__${name}__*`);
}

function getBranch(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      stdio: 'pipe',
      timeout: 5_000,
    })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

function stageImages(cwd: string, images: Array<{ data: string; mediaType: string }>): string[] {
  const imgDir = join(cwd, '.mitzo-images');
  mkdirSync(imgDir, { recursive: true });

  const extMap: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
  };

  const paths: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const ext = extMap[img.mediaType] || '.jpg';
    const filename = `image-${Date.now()}-${i}${ext}`;
    const filePath = join(imgDir, filename);
    writeFileSync(filePath, Buffer.from(img.data, 'base64'));
    paths.push(filePath);
  }
  return paths;
}

/**
 * When "Always Allow" is tapped on an MCP tool like mcp__atlassian__jira_get_issue,
 * allow the entire MCP server (mcp__atlassian__*) so the user isn't prompted for
 * every tool from the same server. Non-MCP tools are added individually.
 */
function addToAllowList(allowList: Set<string>, toolName: string): void {
  const mcpPrefix = getMcpPrefix(toolName);
  if (mcpPrefix) {
    allowList.add(mcpPrefix);
  } else {
    allowList.add(toolName);
  }
}

function isAllowListed(allowList: Set<string>, toolName: string): boolean {
  if (allowList.has(toolName)) return true;
  const mcpPrefix = getMcpPrefix(toolName);
  return mcpPrefix !== null && allowList.has(mcpPrefix);
}

function getMcpPrefix(toolName: string): string | null {
  if (!toolName.startsWith('mcp__')) return null;
  const parts = toolName.split('__');
  if (parts.length >= 3) return `${parts[0]}__${parts[1]}__`;
  return null;
}

function buildPermissionHandler(clientId: string) {
  return async (
    toolName: string,
    _toolInput: Record<string, unknown>,
    opts: {
      signal: AbortSignal;
      toolUseID: string;
      title?: string;
      displayName?: string;
      description?: string;
      decisionReason?: string;
    },
  ): Promise<PermissionResult> => {
    const session = registry.get(clientId);
    if (!session) return { behavior: 'deny', message: 'Session not found' };

    const tier = getToolTier(toolName);

    if (shouldAutoAllow(toolName, session.mode)) {
      return { behavior: 'allow', updatedInput: _toolInput };
    }

    if (isAllowListed(session.sessionAllowList, toolName)) {
      return {
        behavior: 'allow',
        decisionClassification: 'user_permanent',
        updatedInput: _toolInput,
      };
    }

    const inputSummary = summarizeToolInput(toolName, _toolInput);

    return new Promise<PermissionResult>((resolve) => {
      if (opts.signal.aborted) {
        resolve({ behavior: 'deny', message: 'Aborted' });
        return;
      }

      const permId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const wrappedResolve = (result: PermissionResult) => {
        if (result.behavior === 'allow' && result.decisionClassification === 'user_permanent') {
          addToAllowList(session.sessionAllowList, toolName);
        }
        resolve(result);
      };

      const onAbort = () => {
        if (hasPending(permId)) {
          removePending(permId);
          resolve({ behavior: 'deny', message: 'Aborted' });
          send(session.ws, { type: 'permission_timeout', permId });
        }
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });

      registerPending(permId, toolName, wrappedResolve, _toolInput, tier);

      send(session.ws, {
        type: 'permission_request',
        permId,
        toolName,
        toolInput: inputSummary,
        title: opts.title,
        description: opts.description,
        displayName: opts.displayName,
        decisionReason: opts.decisionReason,
        tier,
      });

      if (ntfyConfigured()) {
        setTimeout(() => {
          if (hasPending(permId)) sendPermissionNotification(toolName, inputSummary, permId);
        }, 10_000);
      }

      setTimeout(() => {
        if (hasPending(permId)) {
          removePending(permId);
          opts.signal.removeEventListener('abort', onAbort);
          resolve({ behavior: 'deny', message: 'Permission request timed out' });
          send(session.ws, { type: 'permission_timeout', permId });
        }
      }, 120_000);
    });
  };
}

export async function startChat(
  ws: WebSocket,
  clientId: string,
  prompt: string,
  options: {
    resume?: string;
    cwd?: string;
    model?: string;
    extraTools?: string;
    mode?: MitzoMode;
    worktree?: boolean;
    images?: Array<{ data: string; mediaType: string }>;
  },
) {
  const abortController = new AbortController();
  const mode = options.mode || 'agent';
  const baseCwd = options.cwd || BASE_REPO;

  const { cwd, worktreePath } = resolveWorktree(ws, baseCwd, options);

  let fullPrompt = prompt;
  if (options.images?.length) {
    const paths = stageImages(cwd, options.images);
    const imageRefs = paths.map((p) => `- ${p}`).join('\n');
    fullPrompt = `${prompt}\n\nI've attached ${paths.length} image(s). Read them using the Read tool:\n${imageRefs}`;
  }

  const modeAllowed = getAllowedToolsForMode(mode);
  const mcpAllowed = buildMcpAllowedTools();
  const extraTools = options.extraTools ? options.extraTools.split(',').map((t) => t.trim()) : [];

  registry.register(clientId, {
    ws,
    abortController,
    mode,
    sessionAllowList: new Set<string>(),
    worktreePath,
  });

  const branch = getBranch(cwd);
  send(ws, {
    type: 'session_info',
    branch,
    cwd,
    worktree: !!worktreePath,
  });

  const q = query({
    prompt: fullPrompt,
    options: {
      cwd,
      env: sdkEnv(),
      abortController,
      includePartialMessages: true,
      settingSources: ['project'],
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append:
          'This is Mitzo, a mobile chat interface. The user is on their phone.\n' +
          '- Never take mutating actions (writes, comments, transitions, commits) without explicit user approval. Present analysis first, wait for confirmation.\n' +
          '- Read operations are fine without asking.\n' +
          '- Keep responses concise — small screen.\n' +
          '- Read CLAUDE.md and .cursor/rules/ for project context before doing substantive work.',
      },
      permissionMode: MODE_TO_SDK[mode] as 'plan' | 'default' | 'bypassPermissions',
      allowedTools: [...modeAllowed, ...mcpAllowed, ...extraTools],
      ...(options.model ? { model: options.model } : {}),
      ...(options.resume ? { resume: options.resume } : {}),
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      canUseTool: buildPermissionHandler(clientId),
    },
  });

  const session = registry.get(clientId)!;
  session.queryInstance = q;

  const messageHandler = (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'permission_response' && msg.permId) {
        resolvePending(msg.permId, msg.decision || 'deny');
      } else if (msg.type === 'set_mode' && msg.mode) {
        registry.setMode(clientId, msg.mode);
        send(session.ws, { type: 'mode_changed', mode: msg.mode });
      }
    } catch {
      // Malformed WS message — ignore
    }
  };
  ws.on('message', messageHandler);

  try {
    for await (const msg of q) {
      const currentSession = registry.get(clientId);
      if (!currentSession) break;
      const currentWs = currentSession.ws;

      if (msg.type === 'assistant') {
        if (msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text') {
              send(currentWs, { type: 'text', text: block.text });
            } else if (block.type === 'tool_use') {
              send(currentWs, {
                type: 'tool_call',
                toolName: block.name,
                toolId: block.id,
                input: summarizeToolInput(block.name, block.input as Record<string, unknown>),
              });
            }
          }
        }
        if (!currentSession.sessionId && msg.session_id) {
          registry.setSessionId(clientId, msg.session_id);
          send(currentWs, { type: 'session_id', sessionId: msg.session_id });
        }
      } else if (msg.type === 'result') {
        if (msg.session_id) send(currentWs, { type: 'session_id', sessionId: msg.session_id });
        send(currentWs, { type: 'done', sessionId: msg.session_id });
      } else if (msg.type === 'stream_event') {
        const evt = msg.event;
        if (evt?.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          send(currentWs, { type: 'text_delta', text: evt.delta.text });
        }
      } else if (msg.type === 'user') {
        // Send tool results for both local tools and MCP tools.
        // msg.tool_use_result is only set for local tools; MCP tools
        // still produce tool_result blocks in content without that field.
        const content = (msg.message as unknown as Record<string, unknown>)?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              const resultText = extractToolResultText(block.content);
              send(currentWs, {
                type: 'tool_result',
                toolId: block.tool_use_id || '',
                result: resultText.slice(0, 10_000),
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
      send(currentSession.ws, { type: 'error', error: message });
    }
  } finally {
    ws.removeListener('message', messageHandler);
    const finalSession = registry.get(clientId);
    if (finalSession) {
      const finalWs = finalSession.ws;
      registry.remove(clientId);
      if (finalWs.readyState === finalWs.OPEN) {
        send(finalWs, { type: 'done', sessionId: finalSession.sessionId });
      }
    }
  }
}

export function stopChat(clientId: string) {
  registry.abort(clientId);
}
export function detachChat(clientId: string) {
  registry.detach(clientId);
}
export function reattachChat(clientId: string, ws: WebSocket): boolean {
  return registry.reattach(clientId, ws);
}
export function isActive(clientId: string): boolean {
  return registry.isActive(clientId);
}

function getSessionDirs(): string[] {
  const dirs = [BASE_REPO];
  const sessionsDir = `${BASE_REPO}-sessions`;
  try {
    const entries = readdirSync(sessionsDir);
    for (const e of entries) {
      if (e.startsWith('session-')) dirs.push(join(sessionsDir, e));
    }
  } catch {
    /* No sessions dir yet */
  }
  const claudeProjects = join(homedir(), '.claude', 'projects');
  const prefix = BASE_REPO.replace(/\//g, '-').replace(/^-/, '-');
  const sessionsPrefix = `${prefix}-sessions-session-`;
  try {
    for (const entry of readdirSync(claudeProjects)) {
      if (entry.startsWith(sessionsPrefix)) {
        const originalPath = entry.replace(/^-/, '/').replace(/-/g, '/');
        if (!dirs.includes(originalPath)) dirs.push(originalPath);
      }
    }
  } catch {
    /* No claude projects dir */
  }
  return dirs;
}

const hiddenSessionIds = new Set<string>();
export function hideSession(sessionId: string) {
  hiddenSessionIds.add(sessionId);
}
export function clearHiddenSessions() {
  hiddenSessionIds.clear();
}

export async function getSessions() {
  const seen = new Map<
    string,
    { id: string; summary: string; lastModified: number; branch?: string }
  >();
  for (const dir of getSessionDirs()) {
    try {
      const sessions = await listSessions({ dir, limit: 20 });
      for (const s of sessions) {
        if (hiddenSessionIds.has(s.sessionId)) continue;
        const existing = seen.get(s.sessionId);
        if (!existing || s.lastModified > existing.lastModified) {
          seen.set(s.sessionId, {
            id: s.sessionId,
            summary: s.summary,
            lastModified: s.lastModified,
            branch: s.gitBranch,
          });
        }
      }
    } catch {
      /* Dir might not exist */
    }
  }
  const deduped = Array.from(seen.values());
  deduped.sort((a, b) => b.lastModified - a.lastModified);
  return deduped.slice(0, 20);
}

export async function getMessages(sessionId: string) {
  let rawMessages: Array<{ type: string; message?: Record<string, unknown> }> = [];
  for (const dir of getSessionDirs()) {
    try {
      rawMessages = (await getSessionMessages(sessionId, {
        dir,
        limit: 100,
      })) as typeof rawMessages;
      if (rawMessages.length > 0) break;
    } catch {
      /* Try next dir */
    }
  }
  try {
    return rawMessages
      .map((m) => {
        const content = m.message?.content;
        if (!Array.isArray(content)) return null;
        const parsed = parseContentBlocks(content);
        return {
          role: m.type,
          text: parsed.text || undefined,
          toolCalls: parsed.toolCalls.length > 0 ? parsed.toolCalls : undefined,
          toolResults: parsed.toolResults.length > 0 ? parsed.toolResults : undefined,
        };
      })
      .filter(
        (m): m is NonNullable<typeof m> => m !== null && !!(m.text || m.toolCalls || m.toolResults),
      );
  } catch {
    return [];
  }
}
