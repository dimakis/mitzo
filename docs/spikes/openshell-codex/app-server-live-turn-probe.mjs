import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import readline from 'node:readline';

const server = spawn('codex', ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
let threadId;
let finished = false;
const done = (code, message) => {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  server.kill();
  process.stdout.write(`${message}\n`);
  if (code && stderr) process.stderr.write(stderr.slice(0, 4000));
  process.exit(code);
};
const send = (message) => server.stdin.write(`${JSON.stringify(message)}\n`);
const timer = setTimeout(() => done(1, 'LIVE_APP_SERVER_TURN=timeout'), 120_000);

server.stderr.on('data', (data) => { stderr += data.toString(); });
server.on('error', (error) => done(1, `LIVE_APP_SERVER_TURN=error:${error.message}`));
server.on('exit', (code) => { if (!finished) done(1, `LIVE_APP_SERVER_TURN=server-exit:${code}`); });

readline.createInterface({ input: server.stdout }).on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.error) return done(1, `LIVE_APP_SERVER_TURN=rpc-error:${message.error.message ?? 'unknown'}`);
  if (message.id === 0 && message.result) {
    send({ method: 'initialized', params: {} });
    send({ method: 'thread/start', id: 1, params: { cwd: '/sandbox/workspaces/primary' } });
  } else if (message.id === 1 && message.result?.thread?.id) {
    threadId = message.result.thread.id;
    send({
      method: 'turn/start',
      id: 2,
      params: {
        threadId,
        input: [{ type: 'text', text: 'Create /sandbox/workspaces/primary/live-turn.txt containing exactly LIVE_MODEL_TOOL_LOOP=pass. Use a shell command. Then reply with exactly done.' }],
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'externalSandbox', networkAccess: 'restricted' },
      },
    });
  } else if (message.method === 'turn/completed' && message.params?.threadId === threadId) {
    const file = '/sandbox/workspaces/primary/live-turn.txt';
    const passed = message.params?.turn?.status === 'completed'
      && existsSync(file)
      && readFileSync(file, 'utf8').trim() === 'LIVE_MODEL_TOOL_LOOP=pass';
    done(passed ? 0 : 1, passed ? 'LIVE_APP_SERVER_TURN=pass' : 'LIVE_APP_SERVER_TURN=fail');
  }
});

send({
  method: 'initialize',
  id: 0,
  params: { clientInfo: { name: 'mitzo_spike', version: '1.0.0' }, capabilities: { experimentalApi: true } },
});
