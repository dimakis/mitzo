// Opt-in only: MITZO_REAL_CODEX_PROBE=1 node local-checkpoint-resume-probe.mjs
// Starts no model turn and never reads the user's HOME or Codex state.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';

if (process.env.MITZO_REAL_CODEX_PROBE !== '1') {
  console.log('LOCAL_CODEX_CHECKPOINT_RESUME=skipped (set MITZO_REAL_CODEX_PROBE=1)');
  process.exit(0);
}
const codex = process.env.CODEX_BIN ?? '/opt/homebrew/bin/codex';
const helper = new URL('./mitzo-checkpoint.py', import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), 'mitzo-local-checkpoint-'));
const home = join(root, 'home');
const codexHome = join(home, '.codex');
const workspace = join(root, 'workspaces', 'mgmt');
mkdirSync(workspace, { recursive: true });
mkdirSync(codexHome, { recursive: true });
mkdirSync(join(root, 'tmp'), { recursive: true });
const env = {
  PATH: process.env.PATH ?? '',
  HOME: home,
  CODEX_HOME: codexHome,
  TMPDIR: join(root, 'tmp'),
  NO_COLOR: '1',
};
const identity = [
  '--conversation',
  'local-probe',
  '--thread',
  'THREAD',
  '--binding',
  'binding',
  '--image',
  'codex-0.153.4',
  '--policy',
  'policy',
  '--sandbox-id',
  'local',
  '--resource-version',
  '1',
  '--account-provider',
  'openai',
  '--account-id',
  'isolated',
  '--provider',
  'openai',
  '--model',
  'none',
  '--profile-revision',
  '0',
  '--runtime-scope',
  'local',
  '--route-kind',
  'api',
  '--route-provider',
  'openai',
];
function names(root, relative = '') {
  return readdirSync(join(root, relative), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? names(root, join(relative, entry.name)) : [join(relative, entry.name)],
  );
}
function rpc(args, start, turn = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(codex, ['app-server', '--stdio', ...args], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let thread;
    let stderr = '';
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      child.stdin.end();
      setTimeout(() => child.kill(), 1000).unref();
      error ? reject(error) : resolve(value);
    };
    const timeout = setTimeout(
      () => finish(new Error('app-server timeout: ' + stderr.slice(0, 1000))),
      10000,
    );
    child.stderr.on('data', (v) => (stderr += v));
    child.on('error', finish);
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.error) return finish(new Error(m.error.message));
      if (m.id === 0) {
        child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
        child.stdin.write(JSON.stringify(start(thread)) + '\n');
      } else if (m.id === 1 && m.result?.thread?.id) {
        thread = m.result.thread.id;
        if (!turn) {
          clearTimeout(timeout);
          finish(null, m.result);
        } else
          child.stdin.write(
            JSON.stringify({
              method: 'turn/start',
              id: 2,
              params: {
                threadId: thread,
                input: [{ type: 'text', text: 'Reply SYNTHETIC' }],
                approvalPolicy: 'never',
                sandboxPolicy: { type: 'externalSandbox', networkAccess: 'restricted' },
              },
            }) + '\n',
          );
      } else if (turn && m.method === 'turn/completed' && m.params?.threadId === thread) {
        clearTimeout(timeout);
        finish(null, { thread: { id: thread }, turn: m.params.turn });
      }
    });
    child.stdin.write(
      JSON.stringify({
        method: 'initialize',
        id: 0,
        params: {
          clientInfo: { name: 'mitzo-local-checkpoint', version: '1' },
          capabilities: { experimentalApi: true },
        },
      }) + '\n',
    );
  });
}
function run(binary, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '',
      err = '';
    p.stdout.on('data', (x) => (out += x));
    p.stderr.on('data', (x) => (err += x));
    p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(err))));
  });
}
try {
  const fixture = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'resp_local',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'SYNTHETIC' }],
          },
        ],
      }),
    );
  });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const port = fixture.address().port;
  const config = [
    '-c',
    'model_provider="fixture"',
    '-c',
    `model_providers.fixture={name="fixture",base_url="http://127.0.0.1:${port}/v1",env_key="FIXTURE_KEY",wire_api="responses"}`,
    '-c',
    'model="fixture-model"',
  ];
  env.FIXTURE_KEY = 'synthetic';
  const started = await rpc(
    config,
    () => ({ method: 'thread/start', id: 1, params: { cwd: workspace } }),
    true,
  );
  const thread = started.thread.id;
  await new Promise((resolve) => fixture.close(resolve));
  const providerEntries = existsSync(codexHome) ? readdirSync(codexHome).sort() : [];
  const sessionEntries = existsSync(join(codexHome, 'sessions'))
    ? names(join(codexHome, 'sessions')).sort()
    : [];
  const rollout = join(
    codexHome,
    'sessions',
    sessionEntries.find((entry) => entry.startsWith('2026/') && entry.endsWith('.jsonl')) ??
      'missing',
  );
  const first = JSON.parse(readFileSync(rollout, 'utf8').split('\n', 1)[0]);
  if (first.type !== 'session_meta' || first.payload?.id !== thread)
    throw new Error('unexpected rollout session metadata');
  const archive = join(root, 'checkpoint.tar');
  const actual = [...identity];
  actual[actual.indexOf('THREAD')] = thread;
  await run('python3', [
    helper,
    'capture',
    '--provider-root',
    codexHome,
    '--workspace-root',
    workspace,
    '--output',
    archive,
    ...actual,
  ]);
  rmSync(codexHome, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  await run('python3', [
    helper,
    'restore',
    '--input',
    archive,
    '--provider-root',
    codexHome,
    '--workspace-root',
    workspace,
    '--replace-fresh-roots',
    ...actual,
  ]);
  const resumed = await rpc(config, () => ({
    method: 'thread/resume',
    id: 1,
    params: { threadId: thread },
  }));
  if (resumed.thread?.id !== thread || !JSON.stringify(resumed).includes('SYNTHETIC'))
    throw new Error('thread/resume did not retain synthetic history');
  console.log(
    `LOCAL_CODEX_CHECKPOINT_RESUME=pass provider_entries=${providerEntries.join(',')} session_entries=${sessionEntries.join(',')} rollout_header=${first.type}:${first.payload.id}`,
  );
} catch (error) {
  console.error(
    `LOCAL_CODEX_CHECKPOINT_RESUME=fail ${error.message} provider_entries=${existsSync(codexHome) ? readdirSync(codexHome).sort().join(',') : 'removed'}`,
  );
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
