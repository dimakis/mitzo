import { spawn } from 'node:child_process';
import readline from 'node:readline';

const server = spawn('codex', ['app-server', '--stdio'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
let finished = false;
const done = (code, message) => {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  server.kill();
  if (message) process.stdout.write(`${message}\n`);
  if (code && stderr) process.stderr.write(stderr.slice(0, 2000));
  process.exit(code);
};
const send = (message) => server.stdin.write(`${JSON.stringify(message)}\n`);
const timer = setTimeout(() => done(1, 'APP_SERVER_EXTERNAL_EXEC=timeout'), 10_000);

server.stderr.on('data', (data) => {
  stderr += data.toString();
});
server.on('error', (error) => done(1, `APP_SERVER_EXTERNAL_EXEC=error:${error.message}`));
server.on('exit', (code) => {
  if (!finished) done(1, `APP_SERVER_EXTERNAL_EXEC=server-exit:${code}`);
});

readline.createInterface({ input: server.stdout }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === 0 && message.result) {
    send({ method: 'initialized', params: {} });
    send({
      method: 'command/exec',
      id: 2,
      params: {
        command: ['/bin/sh', '-lc', 'printf APP_SERVER_EXTERNAL_EXEC=pass'],
        cwd: '/sandbox',
        sandboxPolicy: { type: 'externalSandbox', networkAccess: 'restricted' },
        timeoutMs: 5_000,
      },
    });
  }
  if (message.id === 2) {
    const passed = message.result?.exitCode === 0 && message.result?.stdout.includes('pass');
    done(
      passed ? 0 : 1,
      passed ? 'APP_SERVER_EXTERNAL_EXEC=pass' : 'APP_SERVER_EXTERNAL_EXEC=fail',
    );
  }
});

send({
  method: 'initialize',
  id: 0,
  params: {
    clientInfo: { name: 'mitzo_spike', title: 'Mitzo spike', version: '1.0.0' },
    capabilities: { experimentalApi: true },
  },
});
