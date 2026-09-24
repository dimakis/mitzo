import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';

const supportedCodexVersion = '0.153.4';
const version = spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 5000 });
if (
  version.error ||
  version.status !== 0 ||
  version.stdout.trim() !== `codex-cli ${supportedCodexVersion}`
) {
  process.stderr.write(
    `Expected codex-cli ${supportedCodexVersion}; refusing unreviewed runtime\n`,
  );
  process.exit(1);
}

const root = mkdtempSync(join(tmpdir(), 'mitzo-web-search-contract-'));
const codexHome = join(root, 'codex-home');
const workspace = join(root, 'workspace');
mkdirSync(codexHome);
mkdirSync(workspace);

const server = spawn('codex', ['app-server', '--stdio'], {
  env: { ...process.env, CODEX_HOME: codexHome },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
let finished = false;
let threadId;
let resumeAccepted = false;

const send = (message) => server.stdin.write(`${JSON.stringify(message)}\n`);
const done = (code, detail) => {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  server.kill();
  rmSync(root, { recursive: true, force: true });
  process.stdout.write(`CODEX_WEB_SEARCH_LIFECYCLE=${code ? 'fail' : 'pass'} ${detail}\n`);
  if (code && stderr) process.stderr.write(stderr.slice(0, 4000));
  process.exit(code);
};
const timer = setTimeout(() => done(1, 'timeout'), 15_000);

server.stderr.on('data', (data) => {
  stderr += data.toString();
});
server.on('error', (error) => done(1, `spawn:${error.message}`));
server.on('exit', (code) => {
  if (!finished) done(1, `server-exit:${code}`);
});

readline.createInterface({ input: server.stdout }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === 0) {
    if (message.error) return done(1, `initialize:${message.error.message ?? 'unknown'}`);
    send({ method: 'initialized', params: {} });
    send({
      method: 'thread/start',
      id: 1,
      params: { cwd: workspace, ephemeral: false, config: { web_search: 'disabled' } },
    });
  } else if (message.id === 1) {
    if (message.error) return done(1, `thread/start:${message.error.message ?? 'unknown'}`);
    threadId = message.result?.thread?.id;
    if (!threadId) return done(1, 'thread/start:no-thread');
    send({
      method: 'thread/resume',
      id: 2,
      params: { threadId, cwd: workspace, config: { web_search: 'live' } },
    });
  } else if (message.id === 2) {
    if (message.error) {
      if (!/no rollout found/i.test(message.error.message ?? ''))
        return done(1, `thread/resume:${message.error.message ?? 'unknown'}`);
      resumeAccepted = true;
    } else {
      if (message.result?.thread?.id !== threadId) return done(1, 'thread/resume:mismatch');
      resumeAccepted = true;
    }
    send({
      method: 'thread/fork',
      id: 3,
      params: { threadId, cwd: workspace, config: { web_search: 'disabled' } },
    });
  } else if (message.id === 3) {
    if (!resumeAccepted) return done(1, 'thread/resume:not-accepted');
    if (message.error) {
      if (!/no rollout found/i.test(message.error.message ?? ''))
        return done(1, `thread/fork:${message.error.message ?? 'unknown'}`);
    } else if (!message.result?.thread?.id || message.result.thread.id === threadId) {
      return done(1, 'thread/fork:no-new-thread');
    }
    done(0, 'start=disabled resume=live:accepted fork=disabled:accepted');
  }
});

send({
  method: 'initialize',
  id: 0,
  params: {
    clientInfo: { name: 'mitzo_web_search_contract', version: '1.0.0' },
    capabilities: { experimentalApi: true },
  },
});
