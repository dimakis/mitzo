import {
  query,
  listSessions,
  getSessionMessages,
  renameSession,
} from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { WebSocket } from 'ws';
import { execFileSync } from 'child_process';
import { writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createWorktree } from './worktree.js';
import { SessionRegistry, type MitzoMode } from './session-registry.js';
import { parseContentBlocks } from './content-blocks.js';
import { loadMcpServers, type McpServerConfig } from './mcp-config.js';
import { getAllowedToolsForMode, applyTierOverrides } from './tool-tiers.js';
import { loadRepoConfig } from './repo-config.js';
import { buildPermissionHandler } from './permission-handler.js';
import { runQueryLoop, createWsMessageHandler } from './query-loop.js';
import { AsyncQueue } from './async-queue.js';
import { GIT_BRANCH_TIMEOUT_MS, SESSION_LIST_LIMIT, SESSION_MESSAGES_LIMIT } from './constants.js';
import { EventStore } from './event-store.js';
import { createLogger } from './logger.js';

const log = createLogger('chat');

// --- Event store (durable session persistence) ---
function initEventStore(): EventStore {
  const repoPath = process.env.REPO_PATH || '.';
  const mitzoDir = join(repoPath, '.mitzo');
  mkdirSync(mitzoDir, { recursive: true });
  const dbPath = join(mitzoDir, 'events.db');
  return new EventStore(dbPath);
}

export const eventStore = initEventStore();

export type { MitzoMode } from './session-registry.js';

let mcpServers: Record<string, McpServerConfig> = {};
try {
  mcpServers = loadMcpServers();
} catch (err: unknown) {
  log.error('failed to load MCP servers', { error: err instanceof Error ? err.message : err });
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

if (Object.keys(repoConfig.toolTierOverrides).length > 0) {
  applyTierOverrides(repoConfig.toolTierOverrides);
  log.info('applied tool tier overrides from .mitzo.json', {
    overrides: repoConfig.toolTierOverrides,
  });
}

const VENV_PATHS = repoConfig.resolvedVenvPaths;

export const AVAILABLE_MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', desc: 'Balanced' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6', desc: 'Most capable' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', desc: 'Fastest' },
];

// --- Pure helper functions ---

function send(ws: WebSocket, data: unknown) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

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

function resolveThinking(
  model?: string,
): { type: 'adaptive' } | { type: 'enabled'; budgetTokens: number } | undefined {
  if (!model || model.includes('opus')) return { type: 'adaptive' };
  if (model.includes('sonnet')) return { type: 'enabled', budgetTokens: 10_000 };
  return undefined;
}

function getBranch(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      stdio: 'pipe',
      timeout: GIT_BRANCH_TIMEOUT_MS,
    })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

function buildMcpAllowedTools(): string[] {
  return Object.keys(mcpServers).map((name) => `mcp__${name}__*`);
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
    log.error('worktree creation failed, using base repo', { error: message });
    send(ws, { type: 'error', error: `Worktree creation failed (using base repo): ${message}` });
    return { cwd: baseCwd };
  }
}

export function assemblePrompt(
  prompt: string,
  cwd: string,
  images?: Array<{ data: string; mediaType: string }>,
): string {
  if (!images?.length) return prompt;
  const paths = stageImages(cwd, images);
  const imageRefs = paths.map((p) => `- ${p}`).join('\n');
  return `${prompt}\n\nI've attached ${paths.length} image(s). Read them using the Read tool:\n${imageRefs}`;
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

// --- Main orchestrator ---

function makeUserMessage(
  content: string,
  priority: 'now' | 'next' | 'later' = 'next',
): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    priority,
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
  const fullPrompt = assemblePrompt(prompt, cwd, options.images);

  const modeAllowed = getAllowedToolsForMode(mode);
  const mcpAllowed = buildMcpAllowedTools();
  const extraTools = options.extraTools ? options.extraTools.split(',').map((t) => t.trim()) : [];

  // Streaming-input queue — kept open for the session lifetime.
  const inputQueue = new AsyncQueue<SDKUserMessage>();
  inputQueue.push(makeUserMessage(fullPrompt, 'now'));

  registry.register(clientId, {
    ws,
    abortController,
    mode,
    cwd,
    sessionAllowList: new Set<string>(),
    worktreePath,
  });

  const session = registry.get(clientId)!;
  session.inputQueue = inputQueue as { push: (msg: unknown) => void; close: () => void };

  const branch = getBranch(cwd);
  send(ws, { type: 'session_info', branch, cwd, worktree: !!worktreePath });

  let messageHandler: ((raw: Buffer) => void) | null = null;
  try {
    const q = query({
      prompt: inputQueue as AsyncIterable<SDKUserMessage>,
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
        thinking: resolveThinking(options.model),
        ...(options.model ? { model: options.model } : {}),
        ...(options.resume ? { resume: options.resume } : {}),
        ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
        canUseTool: buildPermissionHandler(clientId, registry),
      },
    });

    session.queryInstance = q;

    messageHandler = createWsMessageHandler(clientId, registry);
    ws.on('message', messageHandler);

    await runQueryLoop(
      q as unknown as AsyncIterable<Record<string, unknown>>,
      clientId,
      registry,
      abortController,
      ws,
      eventStore,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    log.error('startChat failed after register, cleaning up', { clientId, error: message });
    send(ws, { type: 'error', error: message });
    registry.abort(clientId);
  } finally {
    if (messageHandler) ws.removeListener('message', messageHandler);
  }
}

/** Push a follow-up message into a running session. */
export function sendToChat(
  clientId: string,
  prompt: string,
  images?: Array<{ data: string; mediaType: string }>,
): boolean {
  const session = registry.get(clientId);
  if (!session?.inputQueue) return false;
  const fullPrompt = assemblePrompt(prompt, session.cwd ?? '.', images);
  session.inputQueue.push(makeUserMessage(fullPrompt, 'next'));
  return true;
}

/** Interrupt the current generation and inject a message the model sees immediately. */
export async function interruptChat(
  clientId: string,
  prompt: string,
  images?: Array<{ data: string; mediaType: string }>,
): Promise<boolean> {
  const session = registry.get(clientId);
  if (!session?.queryInstance || !session?.inputQueue) return false;
  const fullPrompt = assemblePrompt(prompt, session.cwd ?? '.', images);
  await session.queryInstance.interrupt();
  session.inputQueue.push(makeUserMessage(fullPrompt, 'now'));
  return true;
}

// --- Session management ---

export function stopChat(clientId: string) {
  const session = registry.get(clientId);
  if (session) {
    session.inputQueue?.close();
    session.queryInstance?.close();
  }
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

// --- Session listing ---

function getSessionDirs(): string[] {
  const dirs = [BASE_REPO];
  const sessionsDir = `${BASE_REPO}-sessions`;
  try {
    const entries = readdirSync(sessionsDir);
    for (const e of entries) {
      if (e.startsWith('session-')) dirs.push(join(sessionsDir, e));
    }
  } catch {
    // Expected when sessions dir doesn't exist yet
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
    // Expected when ~/.claude/projects doesn't exist yet
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

export async function renameSessionById(sessionId: string, title: string): Promise<void> {
  const errors: string[] = [];
  for (const dir of getSessionDirs()) {
    try {
      await renameSession(sessionId, title, { dir });
      return;
    } catch (err: unknown) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  throw new Error('Session not found');
}

export async function getSessions() {
  const seen = new Map<
    string,
    { id: string; summary: string; lastModified: number; branch?: string }
  >();
  for (const dir of getSessionDirs()) {
    try {
      const sessions = await listSessions({ dir, limit: SESSION_LIST_LIMIT });
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
      // Expected when session dir doesn't exist
    }
  }
  const deduped = Array.from(seen.values());
  deduped.sort((a, b) => b.lastModified - a.lastModified);
  return deduped.slice(0, SESSION_LIST_LIMIT);
}

export interface RestoredMessage {
  messageId: string;
  role: string;
  blocks: Array<{
    blockId: string;
    blockType: string;
    content: string;
    toolName?: string;
    toolId?: string;
    toolInput?: string;
    rawInput?: unknown;
    toolResult?: string;
    toolError?: boolean;
  }>;
}

/**
 * Replay v2 events from the event store into finished messages.
 */
function replayEventsToMessages(
  events: import('./event-store.js').StoredEvent[],
): RestoredMessage[] {
  const messages: RestoredMessage[] = [];
  let currentMsg: RestoredMessage | null = null;
  const blockContent = new Map<string, string>();
  const toolResults = new Map<string, { result: string; isError: boolean }>();

  // First pass: collect tool results
  for (const evt of events) {
    if (evt.type === 'tool_result') {
      const p = evt.payload;
      toolResults.set(p.toolId as string, {
        result: p.result as string,
        isError: (p.isError as boolean) ?? false,
      });
    }
  }

  for (const evt of events) {
    const p = evt.payload;
    switch (evt.type) {
      case 'message_start':
        if (currentMsg && currentMsg.blocks.length > 0) {
          messages.push(currentMsg);
        }
        currentMsg = { messageId: p.messageId as string, role: 'assistant', blocks: [] };
        break;

      case 'block_start':
        if (currentMsg) {
          blockContent.set(p.blockId as string, '');
        }
        break;

      case 'block_delta':
        if (currentMsg) {
          const existing = blockContent.get(p.blockId as string) ?? '';
          blockContent.set(p.blockId as string, existing + (p.delta as string));
        }
        break;

      case 'block_end':
        if (currentMsg) {
          const content = blockContent.get(p.blockId as string) ?? '';
          const toolId = p.toolId as string | undefined;
          const tr = toolId ? toolResults.get(toolId) : undefined;
          currentMsg.blocks.push({
            blockId: p.blockId as string,
            blockType: p.blockType as string,
            content,
            ...(p.toolName ? { toolName: p.toolName as string } : {}),
            ...(toolId ? { toolId } : {}),
            ...(p.input ? { toolInput: p.input as string } : {}),
            ...(p.rawInput ? { rawInput: p.rawInput } : {}),
            ...(tr ? { toolResult: tr.result, toolError: tr.isError } : {}),
          });
          blockContent.delete(p.blockId as string);
        }
        break;

      case 'message_end':
        if (currentMsg && currentMsg.blocks.length > 0) {
          messages.push(currentMsg);
        }
        currentMsg = null;
        break;
    }
  }

  // Flush any in-flight message
  if (currentMsg && currentMsg.blocks.length > 0) {
    messages.push(currentMsg);
  }

  return messages;
}

export async function getMessages(sessionId: string) {
  // Primary: replay from durable event store
  const events = eventStore.getSessionEvents(sessionId);
  if (events.length > 0) {
    return replayEventsToMessages(events);
  }

  // Fallback: SDK JSONL for pre-migration sessions
  let rawMessages: RawSdkMessage[] = [];
  for (const dir of getSessionDirs()) {
    try {
      rawMessages = (await getSessionMessages(sessionId, {
        dir,
        limit: SESSION_MESSAGES_LIMIT,
      })) as RawSdkMessage[];
      if (rawMessages.length > 0) break;
    } catch {
      // Session not in this dir — try next
    }
  }
  try {
    return reconstructMessages(rawMessages);
  } catch (err: unknown) {
    log.warn('failed to parse session messages', {
      sessionId,
      error: err instanceof Error ? err.message : 'unknown',
    });
    return [];
  }
}

// --- Legacy SDK JSONL reconstruction (fallback for pre-migration sessions) ---

export interface RawSdkMessage {
  type: string;
  message?: Record<string, unknown>;
}

export function reconstructMessages(rawMessages: RawSdkMessage[]): RestoredMessage[] {
  let blockCounter = 0;

  const toolResultMap = new Map<string, string>();
  for (const m of rawMessages) {
    const content = m.message?.content;
    if (!Array.isArray(content)) continue;
    const parsed = parseContentBlocks(content);
    for (const tr of parsed.toolResults) {
      toolResultMap.set(tr.toolId, tr.result);
    }
  }

  const messages: RestoredMessage[] = [];

  for (const m of rawMessages) {
    const content = m.message?.content;
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
    } else if (Array.isArray(content)) {
      const parsed = parseContentBlocks(content);
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
          toolResult: toolResultMap.get(tc.toolId),
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
