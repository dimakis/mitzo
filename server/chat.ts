import {
  query,
  listSessions,
  getSessionInfo,
  getSessionMessages,
  renameSession,
} from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SessionTransport, ConnectionRegistry } from '@mitzo/harness';
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { randomBytes } from 'crypto';
import { homedir } from 'os';
import { createWorktree, removeWorktree } from './worktree.js';
import { SessionRegistry, type MitzoMode } from './session-registry.js';
import { parseContentBlocks } from './content-blocks.js';
import { loadMcpServers, type McpServerConfig } from './mcp-config.js';
import { getAllowedToolsForMode, applyTierOverrides } from './tool-tiers.js';
import { loadRepoConfig } from './repo-config.js';
import { loadProjectHooks } from './hook-bridge.js';
import { buildPermissionHandler } from './permission-handler.js';
import { runQueryLoop, broadcastToObservers } from './query-loop.js';
import { AsyncQueue } from './async-queue.js';
import { GIT_BRANCH_TIMEOUT_MS, SESSION_PAGE_SIZE, SESSION_MESSAGES_LIMIT } from './constants.js';
import { INTERNAL_TOKEN } from './internal-token.js';
import { buildTaskSystemPrompt } from './task-context.js';
import type { TaskStore } from './task-store.js';

let _taskStore: TaskStore | null = null;
export function setTaskStore(store: TaskStore): void {
  _taskStore = store;
}

let _connRegistry: ConnectionRegistry | null = null;
export function setConnectionRegistry(registry: ConnectionRegistry): void {
  _connRegistry = registry;
}
import { EventStore } from './event-store.js';
import { capturePromptComparison } from './prompt-compare.js';
import { shouldAutoRename, extractRecentPrompts, generateSessionName } from './auto-rename.js';
import { registerSession, updateSessionTitle, finalizeCloseout } from './session-index.js';
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

/** Generate a session-scoped worktree ID: YYYY-MM-DD-<random-hex>. */
export function generateWtId(): string {
  const date = new Date().toISOString().slice(0, 10);
  const rand = randomBytes(3).toString('hex'); // 16M unique values, collision-safe
  return `${date}-${rand}`;
}

const MODE_TO_SDK: Record<MitzoMode, string> = {
  ask: 'plan',
  agent: 'default',
  auto: 'acceptEdits',
};

export const registry = new SessionRegistry();

/** Load repo config with short TTL cache — fresh enough for hot-reload, avoids redundant disk I/O. */
let _cachedConfig: ReturnType<typeof loadRepoConfig> | null = null;
let _cachedAt = 0;
const CONFIG_TTL_MS = 5_000;

export function getRepoConfig() {
  const now = Date.now();
  if (_cachedConfig && now - _cachedAt < CONFIG_TTL_MS) return _cachedConfig;
  _cachedConfig = loadRepoConfig(BASE_REPO);
  _cachedAt = now;
  return _cachedConfig;
}

export const AVAILABLE_MODELS = [
  { id: 'claude-opus-4-7', label: 'Opus 4.7', desc: 'Adaptive thinking' },
  { id: 'claude-opus-4-7:max', label: 'Opus 4.7 Max', desc: 'Max thinking (128k)' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6', desc: 'Previous Opus' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', desc: 'Balanced' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', desc: 'Fastest' },
];

/** Split "claude-opus-4-7:max" → { model: "claude-opus-4-7", effort: "max" } */
export function parseModelSpec(spec?: string): { model: string; effort: string | undefined } {
  if (!spec) return { model: '', effort: undefined };
  const idx = spec.indexOf(':');
  if (idx === -1) return { model: spec, effort: undefined };
  return { model: spec.slice(0, idx), effort: spec.slice(idx + 1) };
}

// --- Pure helper functions ---

/** Send data via transport (isOpen guard is inside the transport). */
function send(transport: SessionTransport, data: Record<string, unknown>) {
  if (transport.isOpen()) transport.send(data);
}

function sdkEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  env.CLAUDE_CODE_USE_VERTEX = process.env.CLAUDE_CODE_USE_VERTEX || '1';
  env.ANTHROPIC_VERTEX_PROJECT_ID = process.env.ANTHROPIC_VERTEX_PROJECT_ID || '';
  env.CLOUD_ML_REGION = process.env.CLOUD_ML_REGION || 'us-east5';

  const existingPath = env.PATH || '/usr/bin:/bin:/usr/local/bin';
  const venvPaths = getRepoConfig().resolvedVenvPaths;
  env.PATH = [...venvPaths, existingPath].join(':');

  delete env.AUTH_PASSPHRASE;
  delete env.AUTH_SECRET;
  delete env.NTFY_AUTH_TOKEN;
  return env;
}

export function resolveThinking(
  spec?: string,
): { type: 'adaptive' } | { type: 'enabled'; budgetTokens: number } | undefined {
  const { model, effort } = parseModelSpec(spec);
  if (model.includes('opus') && effort === 'max') return { type: 'enabled', budgetTokens: 128_000 };
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

function buildMcpAllowedTools(clientId?: string): string[] {
  const patterns = Object.keys(mcpServers).map((name) => `mcp__${name}__*`);
  if (clientId) {
    const session = registry.get(clientId);
    if (session?.taskContext) {
      patterns.push('mcp__task-board__*');
    }
  }
  return patterns;
}

/**
 * Create worktrees for the primary repo and all configured secondary repos.
 * All worktrees share the same session-scoped wtId. Returns the primary
 * worktree path as cwd, plus a map of all repo worktrees.
 */
function createSessionWorktrees(
  transport: SessionTransport,
  baseCwd: string,
  wtId: string,
  options: { resume?: string; cwd?: string },
): {
  cwd: string;
  wtId: string;
  worktreePath?: string;
  repoWorktrees: Map<string, { path: string; wtId: string }>;
} {
  const repoWorktrees = new Map<string, { path: string; wtId: string }>();

  // Skip worktree creation when resuming, using custom cwd, or disabled
  if (!WORKTREE_ENABLED || options.resume || options.cwd || !BASE_REPO) {
    return { cwd: baseCwd, wtId, repoWorktrees };
  }

  // Create primary worktree
  let primaryPath: string | undefined;
  try {
    primaryPath = createWorktree(wtId, BASE_REPO);
    repoWorktrees.set('primary', { path: primaryPath, wtId });
    send(transport, { type: 'worktree', path: primaryPath });
    log.info('primary worktree created', { wtId, path: primaryPath });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('primary worktree creation failed, using base repo', { error: message });
    send(transport, {
      type: 'error',
      error: `Worktree creation failed (using base repo): ${message}`,
    });
    return { cwd: baseCwd, wtId, repoWorktrees };
  }

  // Create worktrees for all configured secondary repos
  const config = getRepoConfig();
  for (const [repoName, repoPath] of Object.entries(config.repos)) {
    try {
      const worktreePath = createWorktree(wtId, repoPath);
      repoWorktrees.set(repoName, { path: worktreePath, wtId });
      log.info('secondary worktree created', { repo: repoName, wtId, path: worktreePath });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('secondary worktree creation failed', { repo: repoName, error: message });
      send(transport, {
        type: 'error',
        error: `Worktree for ${repoName} failed: ${message}`,
      });
    }
  }

  return {
    cwd: primaryPath,
    wtId,
    worktreePath: primaryPath,
    repoWorktrees,
  };
}

const TASK_MCP_SERVER_NAME = 'task-board';

function buildTaskMcpServer(clientId: string): Record<string, McpServerConfig> | null {
  const session = registry.get(clientId);
  if (!session?.taskContext) return null;
  const port = process.env.PORT || '3100';
  return {
    [TASK_MCP_SERVER_NAME]: {
      command: 'node',
      args: [
        '--import',
        'tsx',
        join(__dirname, 'task-mcp-server.ts'),
        '--base-url',
        `http://localhost:${port}`,
        '--client-id',
        clientId,
      ],
      env: { MITZO_INTERNAL_TOKEN: INTERNAL_TOKEN },
    },
  };
}

function buildTaskPromptForSession(clientId: string): string {
  if (!_taskStore) return '';
  const session = registry.get(clientId);
  if (!session?.taskContext) return '';
  return buildTaskSystemPrompt(_taskStore, session.taskContext.currentTaskId);
}

/**
 * Build system prompt section listing all session worktrees.
 * Lists ALL repos including primary so the agent has a complete lookup table
 * for navigating between repos (the "cd back" problem).
 */
export function buildWorktreeSystemPrompt(
  repoWorktrees: Map<string, { path: string; wtId: string }>,
): string {
  if (repoWorktrees.size === 0) return '';

  const lines = ['\n\n## Session Worktrees'];
  lines.push(`Session ID: ${repoWorktrees.values().next().value?.wtId ?? 'unknown'}`);
  lines.push(
    'This session has isolated worktrees. ALL work MUST happen in these paths. ' +
      'When switching repos, cd to the worktree path — never to the repo root.',
  );
  lines.push('');
  for (const [name, { path }] of repoWorktrees) {
    const label = name === 'primary' ? `${name} (cwd)` : name;
    lines.push(`- **${label}**: \`${path}\``);
  }
  lines.push('');
  lines.push(
    'Env vars `$MITZO_REPO_<NAME>` also hold these paths. ' +
      'Read operations from main worktrees are OK for reference.',
  );
  return lines.join('\n');
}

const CONTEXT_BLOCK_MAX_BYTES = 100 * 1024; // 100 KB

/** Escape characters that would break XML attribute values. */
function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function assemblePrompt(
  prompt: string,
  cwd: string,
  images?: Array<{ data: string; mediaType: string }>,
  contextBlocks?: string[],
): string {
  let result = prompt;

  // Inject context blocks before the user's message
  if (contextBlocks?.length) {
    const config = getRepoConfig();
    const blocks: string[] = [];
    for (const name of contextBlocks) {
      const filePath = config.contextBlocks[name];
      if (!filePath) continue;
      let content: string;
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch {
        log.warn('context block file not found', { name, path: filePath });
        continue;
      }
      if (Buffer.byteLength(content, 'utf-8') > CONTEXT_BLOCK_MAX_BYTES) {
        content = Buffer.from(content, 'utf-8')
          .subarray(0, CONTEXT_BLOCK_MAX_BYTES)
          .toString('utf-8');
        content += '\n\n[… truncated at 100 KB]';
        log.warn('context block truncated', {
          name,
          path: filePath,
          maxBytes: CONTEXT_BLOCK_MAX_BYTES,
        });
      }
      const safeName = escapeXmlAttr(name);
      const safePath = escapeXmlAttr(filePath);
      blocks.push(`<context name="${safeName}" source="${safePath}">\n${content}\n</context>`);
    }
    if (blocks.length > 0) {
      const preamble =
        'The user has attached the following reference files for this message.\nUse them to inform your response.';
      result = `${preamble}\n\n${blocks.join('\n\n')}\n\n---CONTEXT_END---\n${result}`;
    }
  }

  // Append image references
  if (images?.length) {
    const paths = stageImages(cwd, images);
    const imageRefs = paths.map((p) => `- ${p}`).join('\n');
    result = `${result}\n\nI've attached ${paths.length} image(s). Read them using the Read tool:\n${imageRefs}`;
  }

  return result;
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
  transport: SessionTransport,
  clientId: string,
  prompt: string,
  options: {
    resume?: string;
    cwd?: string;
    model?: string;
    extraTools?: string;
    mode?: MitzoMode;
    images?: Array<{ data: string; mediaType: string }>;
    contextBlocks?: string[];
    clientMsgId?: string;
    onSessionResolved?: (sessionId: string) => void;
  },
) {
  const abortController = new AbortController();
  const mode = options.mode || 'agent';

  // When resuming, look up the original session's CWD from the event store.
  // The SDK stores conversation data under ~/.claude/projects/<encoded-cwd>/,
  // so we must use the same CWD the session was created with — otherwise the
  // SDK can't find the conversation and returns "No conversation found".
  let baseCwd = options.cwd || BASE_REPO;
  if (options.resume && !options.cwd) {
    const sessionMeta = eventStore.getSession(options.resume);
    if (sessionMeta?.cwd) {
      baseCwd = sessionMeta.cwd;
      log.info('resume: using original session CWD', {
        sessionId: options.resume,
        cwd: baseCwd,
      });
    }
  }

  // Generate session-scoped worktree ID and create worktrees in all repos
  const wtId = generateWtId();
  const { cwd, worktreePath, repoWorktrees } = createSessionWorktrees(
    transport,
    baseCwd,
    wtId,
    options,
  );

  const fullPrompt = assemblePrompt(prompt, cwd, options.images, options.contextBlocks);

  // Apply tier overrides from current .mitzo.json (re-read each session start).
  // Always call applyTierOverrides so removed overrides reset to defaults.
  const currentConfig = getRepoConfig();
  applyTierOverrides(currentConfig.toolTierOverrides);

  const modeAllowed = getAllowedToolsForMode(mode);
  const mcpAllowed = buildMcpAllowedTools(clientId);
  const extraTools = options.extraTools ? options.extraTools.split(',').map((t) => t.trim()) : [];

  // Streaming-input queue — kept open for the session lifetime.
  const inputQueue = new AsyncQueue<SDKUserMessage>();
  inputQueue.push(makeUserMessage(fullPrompt, 'now'));

  registry.register(clientId, {
    transport,
    abortController,
    mode,
    cwd,
    wtId,
    sessionAllowList: new Set<string>(),
    worktreePath,
  });

  const session = registry.get(clientId)!;
  session.inputQueue = inputQueue as { push: (msg: unknown) => void; close: () => void };

  // Copy all repo worktrees into the session for cleanup tracking
  for (const [name, info] of repoWorktrees) {
    session.worktreePaths.set(name, info);
  }

  const branch = getBranch(cwd);
  session.branch = branch;
  send(transport, { type: 'session_info', branch, cwd, worktree: !!worktreePath, wtId });

  // Pre-register resumed sessions in EventStore so they're discoverable
  // even if the query loop dies before the first assistant event.
  if (options.resume) {
    eventStore.upsertSession({
      sessionId: options.resume,
      cwd,
      mode,
      branch,
      ...(worktreePath ? { wtId } : {}),
    });
  }

  // Register session in the workspace index (fire-and-forget, best-effort)
  try {
    registerSession(BASE_REPO, wtId, repoWorktrees, branch);
  } catch (err: unknown) {
    log.warn('session index write failed', {
      error: err instanceof Error ? err.message : 'unknown',
    });
  }

  // Build session env with worktree paths for the agent (all repos including primary)
  const sessionEnv = sdkEnv();
  sessionEnv.MITZO_SESSION_ID = wtId;
  for (const [name, { path }] of repoWorktrees) {
    sessionEnv[`MITZO_REPO_${name.toUpperCase()}`] = path;
  }

  // Merge dynamic MCP servers (task board if active)
  const taskMcp = buildTaskMcpServer(clientId);
  const allMcpServers = { ...mcpServers, ...taskMcp };

  // Load project hooks from .claude/settings.json (e.g. SessionStart boot context)
  const hooks = loadProjectHooks(cwd);

  // Build the system prompt append string (used by both query and comparison)
  const systemPromptAppend =
    'This is Mitzo, a mobile chat interface. The user is on their phone.\n' +
    '- Never take mutating actions (writes, comments, transitions, commits) without explicit user approval. Present analysis first, wait for confirmation.\n' +
    '- Read operations are fine without asking.\n' +
    '- Keep responses concise — small screen.\n' +
    '- Read CLAUDE.md and .cursor/rules/ for project context before doing substantive work.' +
    buildWorktreeSystemPrompt(repoWorktrees) +
    buildTaskPromptForSession(clientId);

  // Fire-and-forget: capture prompt comparison for the experiments spoke
  capturePromptComparison(wtId, cwd, systemPromptAppend, repoWorktrees).catch(() => {});

  try {
    const q = query({
      prompt: inputQueue as AsyncIterable<SDKUserMessage>,
      options: {
        cwd,
        env: sessionEnv,
        abortController,
        includePartialMessages: true,
        settingSources: ['project'],
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: systemPromptAppend,
        },
        permissionMode: MODE_TO_SDK[mode] as 'plan' | 'default' | 'bypassPermissions',
        allowedTools: [...modeAllowed, ...mcpAllowed, ...extraTools],
        thinking: resolveThinking(options.model),
        ...(options.model ? { model: parseModelSpec(options.model).model } : {}),
        ...(options.resume ? { resume: options.resume } : {}),
        ...(Object.keys(allMcpServers).length > 0 ? { mcpServers: allMcpServers } : {}),
        ...(hooks ? { hooks } : {}),
        canUseTool: buildPermissionHandler(clientId, registry),
      },
    });

    session.queryInstance = q;

    await runQueryLoop(
      q as unknown as AsyncIterable<Record<string, unknown>>,
      clientId,
      registry,
      abortController,
      eventStore,
      options.resume ? undefined : fullPrompt,
      {
        connRegistry: _connRegistry ?? undefined,
        onSessionResolved: options.onSessionResolved,
      },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    log.error('startChat failed after register, cleaning up', { clientId, error: message });
    send(transport, { type: 'error', error: message });
    const failedSession = registry.get(clientId);
    if (failedSession) cleanupSessionWorktrees(failedSession);
    registry.abort(clientId);
  } finally {
    // Clean up secondary worktrees after query loop ends (session may already
    // be removed from registry, so use the captured reference).
    cleanupSessionWorktrees(session);
  }
}

/**
 * Check if an auto-rename should fire for a session and perform it if so.
 * Runs asynchronously — errors are logged but don't affect the session.
 */
async function tryAutoRename(sessionId: string, clientId: string): Promise<void> {
  try {
    const sessionMeta = eventStore.getSession(sessionId);
    if (!sessionMeta) return;

    const promptCount = eventStore.incrementPromptCount(sessionId);
    if (!shouldAutoRename(promptCount, sessionMeta.manuallyRenamed)) return;

    const events = eventStore.getSessionEvents(sessionId);
    const prompts = extractRecentPrompts(events);
    const newName = await generateSessionName(prompts);
    if (!newName) return;

    log.info('auto-renaming session', { sessionId, promptCount, newName });

    // Update the SDK session name (best-effort, fire-and-forget)
    renameSessionById(sessionId, newName, false).catch((err: unknown) => {
      log.warn('auto-rename SDK call failed', {
        sessionId,
        error: err instanceof Error ? err.message : 'unknown',
      });
    });

    // Update session index title (initial_title frozen, last_title updated)
    const session = registry.get(clientId);
    if (session?.wtId) {
      try {
        updateSessionTitle(BASE_REPO, session.wtId, newName);
      } catch (err: unknown) {
        log.warn('session index title update failed', {
          error: err instanceof Error ? err.message : 'unknown',
        });
      }
    }

    // Push the new name to the connected frontend
    if (session) {
      send(session.transport, { type: 'session_renamed', sessionId, name: newName });
    }
  } catch (err: unknown) {
    log.warn('auto-rename failed', {
      sessionId,
      error: err instanceof Error ? err.message : 'unknown',
    });
  }
}

/** Push a follow-up message into a running session. */
export function sendToChat(
  clientId: string,
  prompt: string,
  images?: Array<{ data: string; mediaType: string }>,
  contextBlocks?: string[],
  clientMsgId?: string,
): boolean {
  const session = registry.get(clientId);
  if (!session?.inputQueue) return false;
  const fullPrompt = assemblePrompt(prompt, session.cwd ?? '.', images, contextBlocks);
  const messageId = clientMsgId || `umsg-${Date.now()}-send`;
  if (session.sessionId) {
    eventStore.append(session.sessionId, 'user_message', {
      v: 2,
      type: 'user_message',
      ts: Date.now(),
      messageId,
      text: fullPrompt,
    });
    tryAutoRename(session.sessionId, clientId).catch(() => {
      /* errors logged internally */
    });
  }
  const echo = { type: 'user_message', messageId, text: fullPrompt };
  send(session.transport, echo);
  broadcastToObservers(session.observers, echo);
  session.inputQueue.push(makeUserMessage(fullPrompt, 'next'));
  return true;
}

/** Interrupt the current generation and inject a message the model sees immediately. */
export async function interruptChat(
  clientId: string,
  prompt: string,
  images?: Array<{ data: string; mediaType: string }>,
  contextBlocks?: string[],
  clientMsgId?: string,
): Promise<boolean> {
  const session = registry.get(clientId);
  if (!session?.queryInstance || !session?.inputQueue) return false;
  const fullPrompt = assemblePrompt(prompt, session.cwd ?? '.', images, contextBlocks);
  const messageId = clientMsgId || `umsg-${Date.now()}-interrupt`;
  if (session.sessionId) {
    eventStore.append(session.sessionId, 'user_message', {
      v: 2,
      type: 'user_message',
      ts: Date.now(),
      messageId,
      text: fullPrompt,
    });
  }
  const echo = { type: 'user_message', messageId, text: fullPrompt };
  send(session.transport, echo);
  broadcastToObservers(session.observers, echo);
  await session.queryInstance.interrupt();
  session.inputQueue.push(makeUserMessage(fullPrompt, 'now'));
  return true;
}

// --- Session management ---

/**
 * Best-effort cleanup of all worktrees for a session (primary + secondary).
 * Worktree directories are removed but branches are preserved for PRs.
 */
function cleanupSessionWorktrees(session: import('./session-registry.js').ManagedSession): void {
  const config = getRepoConfig();
  for (const [repoName, { wtId }] of session.worktreePaths) {
    // For 'primary', use BASE_REPO; for secondary repos, look up in config
    const repoPath = repoName === 'primary' ? BASE_REPO : config.repos[repoName];
    if (!repoPath) continue;
    try {
      removeWorktree(wtId, repoPath);
    } catch (err: unknown) {
      log.warn('failed to clean up session worktree', {
        repoName,
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  }
  session.worktreePaths.clear();
}

const CLOSEOUT_PROMPT = `This session is closing in 10 minutes due to inactivity.
Please perform session closeout:

1. If there is uncommitted work in any worktree, commit it now with a descriptive message
2. If there are memory-worthy observations, decisions, or patterns — write them to memory/Observations/ or memory/Decisions/
3. Write a 2-3 sentence summary of what was accomplished and what remains unfinished — output it as your final chat message so it appears in the conversation history
4. Do not ask for confirmation — just do it`;

/**
 * Graceful session closeout. Called by the registry's closeout handler
 * when the detach TTL is about to expire. Injects a closeout prompt into
 * the agent's input queue so it can commit work and write memory while it
 * still has full conversation context.
 */
export function closeoutSession(clientId: string): void {
  const session = registry.get(clientId);
  if (!session?.inputQueue) {
    // No active session or input queue — just finalize as abandoned
    if (session?.wtId) {
      try {
        finalizeCloseout(BASE_REPO, session.wtId, {
          status: 'abandoned',
          tokens_used: session.cumulativeSessionTokens,
          cost_usd: session.cumulativeCostUsd,
        });
      } catch {
        // best-effort
      }
    }
    return;
  }

  log.info('injecting closeout prompt', { clientId, wtId: session.wtId });

  // Push the closeout prompt as an interrupt so the agent sees it immediately
  session.inputQueue.push(makeUserMessage(CLOSEOUT_PROMPT, 'now'));

  // The registry's CLOSEOUT_TIMEOUT_MS timer will abort the session after
  // 10 minutes regardless. When the session is finally aborted (by the
  // registry or by natural completion), the index gets finalized.
  //
  // We register a one-time listener on the abort signal to finalize.
  if (session.wtId) {
    const wtId = session.wtId;
    const onAbort = () => {
      const status = registry.isClosingOut(clientId) ? 'abandoned' : 'closed';
      try {
        finalizeCloseout(BASE_REPO, wtId, {
          status,
          tokens_used: session.cumulativeSessionTokens,
          cost_usd: session.cumulativeCostUsd,
        });
      } catch {
        // best-effort
      }
    };
    session.abortController.signal.addEventListener('abort', onAbort, { once: true });
  }
}

// Wire closeout handler on the registry
registry.setCloseoutHandler(closeoutSession);

export function stopChat(clientId: string) {
  const session = registry.get(clientId);
  if (session) {
    cleanupSessionWorktrees(session);
    session.inputQueue?.close();
    session.queryInstance?.close();
  }
  registry.abort(clientId);
}
export function detachChat(clientId: string) {
  registry.detach(clientId);
}
export function reattachChat(clientId: string, transport: SessionTransport): boolean {
  return registry.reattach(clientId, transport);
}
export function isActive(clientId: string): boolean {
  return registry.isActive(clientId);
}

// --- Session listing ---

/**
 * Collect directories to scan for Claude Code sessions.
 *
 * The SDK's listSessions({ dir, includeWorktrees: true }) discovers sessions
 * within a single repo and its git worktrees, but it cannot cross repo
 * boundaries. Since worktree sessions span multiple repos, we must call
 * listSessions once per repo. We discover repos two ways:
 *
 * 1. Explicit repos from .mitzo.json `repos` config.
 * 2. Sibling discovery: derive unique parent dirs from .mitzo.json `roots`,
 *    then scan each parent for child directories that have .git/ or .claude/.
 *
 * This keeps all paths configurable (no hardcoded machine-specific paths).
 */
export function getSessionDirs(options?: { claudeProjectsRoot?: string }): string[] {
  const dirs = [BASE_REPO];
  const seen = new Set([BASE_REPO]);

  try {
    const config = getRepoConfig();

    // 1. Add all explicitly configured repos
    for (const repoPath of Object.values(config.repos)) {
      if (!seen.has(repoPath)) {
        dirs.push(repoPath);
        seen.add(repoPath);
      }
    }

    // 2. Derive unique parent dirs from roots, then scan for sibling projects.
    const parentDirs = new Set<string>();
    for (const root of config.roots) {
      parentDirs.add(dirname(resolve(root.path)));
    }

    for (const parent of parentDirs) {
      try {
        for (const entry of readdirSync(parent, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const child = join(parent, entry.name);
          if (seen.has(child)) continue;
          if (existsSync(join(child, '.git')) || existsSync(join(child, '.claude'))) {
            dirs.push(child);
            seen.add(child);
          }
        }
      } catch {
        // Expected when parent dir doesn't exist
      }
    }
  } catch {
    // Expected when config hasn't loaded yet
  }

  // Legacy location: <repo>-sessions/ sibling directory
  const sessionsDir = `${BASE_REPO}-sessions`;
  try {
    const entries = readdirSync(sessionsDir);
    for (const e of entries) {
      if (e.startsWith('session-')) dirs.push(join(sessionsDir, e));
    }
  } catch {
    // Expected when sessions dir doesn't exist yet
  }

  // Discover worktree sessions from ~/.claude/projects/.
  // When a session runs in a worktree CWD, the SDK stores its data under
  // a project dir derived from that path. Once the worktree is cleaned up,
  // listSessions({ dir: BASE_REPO }) can no longer find those sessions.
  // We scan for project dirs matching <encoded-BASE_REPO>--claude-worktrees-<id>
  // and reconstruct the original worktree path.
  const encodedBase = BASE_REPO.replace(/\//g, '-');
  const wtPrefix = `${encodedBase}--claude-worktrees-`;
  try {
    const claudeProjects = options?.claudeProjectsRoot ?? join(homedir(), '.claude', 'projects');
    for (const entry of readdirSync(claudeProjects)) {
      if (!entry.startsWith(wtPrefix)) continue;
      const wtId = entry.slice(wtPrefix.length);
      if (!wtId) continue;
      const originalPath = `${BASE_REPO}/.claude/worktrees/${wtId}`;
      if (!seen.has(originalPath)) {
        dirs.push(originalPath);
        seen.add(originalPath);
      }
    }
  } catch {
    // Expected when ~/.claude/projects doesn't exist
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

export async function renameSessionById(
  sessionId: string,
  title: string,
  manual = true,
): Promise<void> {
  const errors: string[] = [];
  for (const dir of getSessionDirs()) {
    try {
      await renameSession(sessionId, title, { dir });
      if (manual) {
        eventStore.markManuallyRenamed(sessionId);
      }
      // Also update the summary in the event store
      eventStore.upsertSession({ sessionId, summary: title });
      return;
    } catch (err: unknown) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  throw new Error('Session not found');
}

export async function getSessions(offset = 0, limit = SESSION_PAGE_SIZE) {
  const seen = new Map<
    string,
    { id: string; summary: string; lastModified: number; branch?: string; cwd?: string }
  >();
  // Fetch enough from each dir to cover the requested window after dedup.
  // The SDK handles worktree discovery via includeWorktrees (default true).
  const fetchLimit = offset + limit + 50; // buffer for dedup losses
  for (const dir of getSessionDirs()) {
    try {
      const sessions = await listSessions({ dir, limit: fetchLimit, includeWorktrees: true });
      for (const s of sessions) {
        if (hiddenSessionIds.has(s.sessionId)) continue;
        const existing = seen.get(s.sessionId);
        if (!existing || s.lastModified > existing.lastModified) {
          seen.set(s.sessionId, {
            id: s.sessionId,
            summary: s.summary,
            lastModified: s.lastModified,
            branch: s.gitBranch,
            cwd: s.cwd || undefined,
          });
        }
      }
    } catch {
      // Expected when session dir doesn't exist
    }
  }

  // Reconcile: backfill EventStore for SDK-discovered sessions that Mitzo
  // doesn't track (e.g. sessions orphaned by a server restart mid-query,
  // or created by external agents in a worktree).
  const knownIds = eventStore.getKnownSessionIds(Array.from(seen.keys()));
  let reconciledCount = 0;
  for (const [sessionId, entry] of seen) {
    if (!knownIds.has(sessionId)) {
      eventStore.upsertSession({
        sessionId,
        summary: entry.summary || null,
        cwd: entry.cwd ?? (BASE_REPO || null),
        branch: entry.branch ?? null,
        isActive: false,
        updatedAt: entry.lastModified,
        createdAt: entry.lastModified,
      });
      reconciledCount++;
    }
  }
  if (reconciledCount > 0) {
    log.info('reconciled orphaned sessions', { count: reconciledCount });
  }

  const deduped = Array.from(seen.values());
  deduped.sort((a, b) => b.lastModified - a.lastModified);
  const page = deduped.slice(offset, offset + limit);
  const hasMore = deduped.length > offset + limit;
  return { sessions: page, hasMore };
}

/**
 * Fast session listing from EventStore (SQLite) — no filesystem scan.
 * Returns the same shape as getSessions() for API compatibility.
 */
export function getSessionsCached(offset = 0, limit = SESSION_PAGE_SIZE) {
  const all = eventStore.listSessions().filter((m) => {
    // Hide sessions that were never used through Mitzo (e.g. automated
    // code review sessions discovered from filesystem).  Active sessions
    // always show regardless of turn count.
    if (m.numTurns === 0 && m.promptCount === 0 && !m.isActive) return false;
    return true;
  });
  const page = all.slice(offset, offset + limit);
  const hasMore = all.length > offset + limit;
  return {
    sessions: page.map((m) => ({
      id: m.sessionId,
      summary: m.summary ?? '',
      lastModified: m.updatedAt,
      branch: m.branch ?? undefined,
      cwd: m.cwd ?? undefined,
    })),
    hasMore,
  };
}

/**
 * Background reconciliation: scan filesystem for sessions the EventStore
 * doesn't know about and sync timestamps from the filesystem.
 * Call fire-and-forget after serving cached results.
 */
// Guard against concurrent reconciliation runs. While `_reconciling` is true,
// subsequent page-1 loads that call reconcileSessionsBackground() are no-ops.
// This is safe because the in-flight sync will pick up any changes, and the
// next page-1 request after it completes will trigger a fresh reconciliation.
let _reconciling = false;
export function reconcileSessionsBackground(): void {
  if (_reconciling) return;
  _reconciling = true;
  syncSessionTimestamps()
    .catch(() => {})
    .finally(() => {
      _reconciling = false;
    });
}

/**
 * Full timestamp sync: scan filesystem and update EventStore timestamps
 * for all sessions to match their actual lastModified time.
 */
async function syncSessionTimestamps(): Promise<void> {
  const seen = new Map<
    string,
    { lastModified: number; summary: string; branch?: string; cwd?: string }
  >();
  const fetchLimit = 250;
  for (const dir of getSessionDirs()) {
    try {
      const sessions = await listSessions({ dir, limit: fetchLimit, includeWorktrees: true });
      for (const s of sessions) {
        if (hiddenSessionIds.has(s.sessionId)) continue;
        const existing = seen.get(s.sessionId);
        if (!existing || s.lastModified > existing.lastModified) {
          seen.set(s.sessionId, {
            lastModified: s.lastModified,
            summary: s.summary,
            branch: s.gitBranch,
            cwd: s.cwd || undefined,
          });
        }
      }
    } catch {
      // Expected when session dir doesn't exist
    }
  }

  let synced = 0;
  for (const [sessionId, entry] of seen) {
    const existing = eventStore.getSession(sessionId);
    if (!existing) {
      // New session — insert with correct timestamp
      eventStore.upsertSession({
        sessionId,
        summary: entry.summary || null,
        cwd: entry.cwd ?? (BASE_REPO || null),
        branch: entry.branch ?? null,
        isActive: false,
        updatedAt: entry.lastModified,
        createdAt: entry.lastModified,
      });
      synced++;
    } else if (Math.abs(existing.updatedAt - entry.lastModified) > 60_000) {
      // Timestamp drifted from filesystem — sync it back.
      // Preserves summary from EventStore if it was manually renamed.
      eventStore.upsertSession({
        sessionId,
        updatedAt: entry.lastModified,
        summary: existing.manuallyRenamed ? undefined : entry.summary || undefined,
        branch: entry.branch ?? undefined,
      });
      synced++;
    }
  }
  if (synced > 0) {
    log.info('reconciled session timestamps', { synced, total: seen.size });
  }
}

/**
 * Look up a single session by ID via the Claude SDK.
 * Used as a fallback when the EventStore doesn't have the session yet
 * (e.g. orphaned by a restart or created externally). If found, backfills
 * the EventStore so subsequent lookups are fast.
 */
export async function discoverSession(
  sessionId: string,
): Promise<import('./event-store.js').SessionMeta | null> {
  try {
    const info = await getSessionInfo(sessionId);
    if (!info) return null;
    eventStore.upsertSession({
      sessionId,
      summary: info.summary || null,
      cwd: info.cwd ?? null,
      branch: info.gitBranch ?? null,
      isActive: false,
    });
    log.info('discovered and backfilled session', { sessionId, cwd: info.cwd });
    return eventStore.getSession(sessionId);
  } catch (err: unknown) {
    log.warn('discoverSession failed', {
      sessionId,
      error: err instanceof Error ? err.message : 'unknown',
    });
    return null;
  }
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
 *
 * @param initialPrompt — If provided (from session metadata), injected as the
 *   first user message. This is the primary mechanism for initial prompts.
 *   Legacy sessions that stored the initial prompt as an out-of-order
 *   user_message event are still handled as a fallback.
 */
/** Exported for testing. */
export function replayEventsToMessages(
  events: import('./event-store.js').StoredEvent[],
  initialPrompt?: string,
): RestoredMessage[] {
  const messages: RestoredMessage[] = [];
  let currentMsg: RestoredMessage | null = null;
  const blockContent = new Map<string, string>();
  const toolResults = new Map<string, { result: string; isError: boolean }>();

  // First pass: collect tool results and detect legacy out-of-order initial prompts.
  // Legacy sessions stored the initial user_message after the first assistant turn
  // (sessionId wasn't known until the first assistant event). Detect these so we
  // can either skip them (if initialPrompt is provided) or reorder them (fallback).
  let legacyInitialPromptEvent: import('./event-store.js').StoredEvent | null = null;
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
    if (evt.type === 'message_end') seenMessageEnd = true;
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
    messages.push({
      messageId: `umsg-initial-${Date.now()}`,
      role: 'user',
      blocks: [{ blockId: 'user-initial', blockType: 'text', content: initialPrompt }],
    });
  } else if (legacyInitialPromptEvent) {
    const p = legacyInitialPromptEvent.payload;
    messages.push({
      messageId: p.messageId as string,
      role: 'user',
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
    const session = eventStore.getSession(sessionId);
    return replayEventsToMessages(events, session?.initialPrompt ?? undefined);
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
