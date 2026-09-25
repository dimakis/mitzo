#!/usr/bin/env node
/** Live provider acceptance matrix. Requires an explicit Luna model and charge identity. */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';

const accountId = process.env.MITZO_WEB_SEARCH_ACCOUNT_ID;
const model = process.env.MITZO_WEB_SEARCH_MODEL;
const bin = process.env.MITZO_WEB_SEARCH_CODEX_BIN;
const accountsFile = process.env.MITZO_WEB_SEARCH_ACCOUNTS_FILE;
if (!accountId || !model || !bin || !accountsFile)
  throw new Error('Explicit account, Luna model, CLI path, and accounts file are required');
if (!/(?:^|-)luna(?:$|-)/i.test(model)) throw new Error('Live acceptance requires Luna');
if (process.env.MITZO_WEB_SEARCH_ACKNOWLEDGE_CHARGE !== `${accountId}:${model}`)
  throw new Error(`Charge acknowledgement must equal ${accountId}:${model}`);
const accounts = JSON.parse(readFileSync(accountsFile, 'utf8'));
const account = accounts.find((item) => item.id === accountId && item.provider === 'openai-codex');
if (!account?.models?.some((item) => item.id === model) || !account.credentialRef)
  throw new Error('Luna model is not configured on the selected Codex account');
// Pin the exact CLI build used to verify this live acceptance protocol.
const version = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 });
if (version.status !== 0 || version.stdout.trim() !== 'codex-cli 0.153.4')
  throw new Error('Live acceptance requires codex-cli 0.153.4');

// Isolate rollouts and copy only the login token into a mode-0700 temporary home.
const root = mkdtempSync(join(tmpdir(), 'mitzo-web-search-live-'));
const home = join(root, 'codex-home');
const cwd = join(root, 'workspace');
mkdirSync(home, { mode: 0o700 });
mkdirSync(cwd);
copyFileSync(join(account.credentialRef, 'auth.json'), join(home, 'auth.json'));
chmodSync(join(home, 'auth.json'), 0o600);

process.stderr.write(`[web-search-live] LIVE CHARGE account=${accountId} model=${model}\n`);
let child;
let output;
let nextId = 0;
const pending = new Map();
let activeTurn = null;
function openClient() {
  child = spawn(bin, ['app-server', '--stdio'], {
    env: { ...process.env, CODEX_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  child.on('error', (error) => rejectAll(error));
  child.on('exit', (code) => rejectAll(new Error(`app-server exited (${code})`)));
  output = readline.createInterface({ input: child.stdout });
  output.on('line', handleLine);
}
async function closeClient() {
  if (!child) return;
  const previous = child;
  previous.removeAllListeners('exit');
  const exited = new Promise((resolve) => previous.once('exit', resolve));
  let timeout;
  try {
    previous.kill();
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          previous.kill('SIGKILL');
          reject(new Error('app-server did not exit after 5 seconds'));
        }, 5000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    output.close();
    child = undefined;
  }
}
function rejectAll(error) {
  for (const item of pending.values()) item.reject(error);
  pending.clear();
  activeTurn?.reject(error);
}
const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
function request(method, params, timeoutMs = 30_000) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    send({ id, method, params });
  });
}
function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id !== undefined && !message.method) {
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    if (message.error) item.reject(new Error(message.error.message ?? 'Provider request failed'));
    else item.resolve(message.result);
  } else if (message.id !== undefined && message.method) {
    send({ id: message.id, error: { code: -32601, message: 'Unsupported host request' } });
  } else if (activeTurn && message.params?.threadId === activeTurn.threadId) {
    if (message.method === 'item/started' || message.method === 'item/completed') {
      if (message.params.item?.type) activeTurn.itemTypes.add(message.params.item.type);
      if (message.params.item?.type === 'webSearch') activeTurn.searched = true;
    }
    if (message.method === 'turn/completed') {
      const finished = activeTurn;
      activeTurn = null;
      if (message.params.turn?.status === 'completed') finished.resolve(finished.searched);
      else finished.reject(new Error(`Turn status: ${message.params.turn?.status ?? 'unknown'}`));
    }
  }
}

const restricted = {
  web_search: 'disabled',
  'features.shell_tool': false,
  'features.unified_exec': false,
  'features.apps': false,
  'features.plugins': false,
  'features.browser_use': false,
  'features.computer_use': false,
  'features.image_generation': false,
  'features.multi_agent': false,
  'features.code_mode': false,
};
const threadParams = (access) => ({
  model,
  modelProvider: 'openai',
  cwd,
  ephemeral: false,
  approvalPolicy: 'never',
  sandbox: 'read-only',
  config: { ...restricted, web_search: access },
  allowProviderModelFallback: false,
});
async function runTurn(
  threadId,
  prompt = 'Use web search to find the current weather in Dublin, Ireland. If web search is unavailable, say so briefly.',
) {
  if (activeTurn) throw new Error('Previous turn is still active');
  let resolveTurn, rejectTurn;
  const completion = new Promise((resolve, reject) => {
    resolveTurn = resolve;
    rejectTurn = reject;
  });
  const monitor = {
    threadId,
    searched: false,
    itemTypes: new Set(),
    resolve: resolveTurn,
    reject: rejectTurn,
  };
  activeTurn = monitor;
  const timer = setTimeout(() => activeTurn?.reject(new Error('Turn timed out')), 120_000);
  try {
    await request(
      'turn/start',
      {
        threadId,
        model,
        input: [{ type: 'text', text: prompt }],
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly' },
      },
      120_000,
    );
    const searched = await completion;
    return { searched, itemTypes: [...monitor.itemTypes] };
  } finally {
    clearTimeout(timer);
    activeTurn = null;
  }
}

async function initializeClient() {
  await request('initialize', {
    clientInfo: { name: 'mitzo_web_search_live_acceptance', version: '1.0.0' },
    capabilities: { experimentalApi: true },
  });
  send({ method: 'initialized', params: {} });
  const identity = await request('account/read', { refreshToken: false });
  if (
    identity?.account?.type !== 'chatgpt' ||
    identity.account.email !== account.email ||
    identity.account.planType !== account.planType
  )
    throw new Error('Configured account identity does not match the active login');
  const catalog = await request('model/list', {});
  if (!JSON.stringify(catalog).includes(`"${model}"`))
    throw new Error('Luna model is not advertised by this account');
}

try {
  openClient();
  await initializeClient();
  const started = await request('thread/start', threadParams('disabled'));
  if (started.model !== model || started.modelProvider !== 'openai')
    throw new Error('Provider model binding changed');
  const threadId = started.thread?.id;
  if (!threadId) throw new Error('thread/start returned no thread');
  const disabledSearch = await runTurn(threadId);
  if (disabledSearch.searched) throw new Error('Disabled thread emitted a webSearch item');
  process.stdout.write('disabled=start:no-web-search\n');

  await closeClient();
  openClient();
  await initializeClient();
  await request('thread/resume', { threadId, ...threadParams('live') });
  let enabledSearch = await runTurn(threadId);
  if (!enabledSearch.searched)
    enabledSearch = await runTurn(
      threadId,
      'Use native web search now to find the current Dublin weather. Do not answer from memory; search first.',
    );
  if (!enabledSearch.searched)
    throw new Error(
      `Allowed resumed thread did not emit webSearch; items=${enabledSearch.itemTypes.join(',')}`,
    );
  process.stdout.write('allowed=resume:web-search-observed\n');

  await closeClient();
  openClient();
  await initializeClient();
  const forked = await request('thread/fork', { threadId, ...threadParams('disabled') });
  const forkId = forked.thread?.id;
  if (!forkId || forkId === threadId) throw new Error('thread/fork returned no new thread');
  const forkSearch = await runTurn(forkId);
  if (forkSearch.searched) throw new Error('Disabled fork emitted a webSearch item');
  process.stdout.write('disabled=fork:no-web-search\n');
} finally {
  try {
    await closeClient();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
