// No inference: exercise the pinned Codex app-server's native OS sandbox only.
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const server = spawn(
  'codex',
  ['app-server', '--stdio', '-c', 'features.use_legacy_landlock=true'],
  {
    stdio: ['pipe', 'pipe', 'pipe'],
  },
);
let stderr = '';
let finished = false;
const done = (ok, message) => {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  server.kill();
  process.stdout.write(`APP_SERVER_READ_ONLY=${message}\n`);
  if (!ok && stderr) process.stderr.write(stderr.slice(0, 2000));
  process.exit(ok ? 0 : 1);
};
const send = (message) => server.stdin.write(`${JSON.stringify(message)}\n`);
const timer = setTimeout(() => done(false, 'timeout'), 20_000);
const markers = ['/sandbox/mitzo-readonly-denial-probe', '/tmp/mitzo-readonly-denial-probe'];
const write = (index) =>
  send({
    method: 'command/exec',
    id: index + 1,
    params: {
      command: ['/bin/sh', '-lc', `printf denied > ${markers[index]}`],
      cwd: '/sandbox',
      sandboxPolicy: { type: 'readOnly' },
      timeoutMs: 5_000,
    },
  });

server.stderr.on('data', (data) => {
  stderr += data.toString();
});
server.on('error', () => done(false, 'spawn-error'));
server.on('exit', () => {
  if (!finished) done(false, 'server-exit');
});
readline.createInterface({ input: server.stdout }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return done(false, 'invalid-response');
  }
  if (message.id === 0 && message.result) {
    send({ method: 'initialized', params: {} });
    write(0);
  } else if (message.id >= 1 && message.id <= markers.length) {
    const index = message.id - 1;
    process.stdout.write(
      `WRITE_${index}_EXIT=${String(message.result?.exitCode ?? 'rpc-error')}\n`,
    );
    process.stdout.write(
      `WRITE_${index}_DETAIL=${String(message.result?.stderr ?? message.error?.message ?? '').slice(0, 500)}\n`,
    );
    if (message.error || message.result?.exitCode === 0)
      return done(false, 'write-allowed-or-policy-unavailable');
    if (message.id < markers.length) return write(message.id);
    send({
      method: 'command/exec',
      id: markers.length + 1,
      params: {
        command: ['/bin/sh', '-lc', 'cat /etc/os-release'],
        cwd: '/sandbox',
        sandboxPolicy: { type: 'readOnly' },
        timeoutMs: 5_000,
      },
    });
  } else if (message.id === markers.length + 1) {
    process.stdout.write(`READ_EXIT=${String(message.result?.exitCode ?? 'rpc-error')}\n`);
    process.stdout.write(
      `READ_DETAIL=${String(message.result?.stderr ?? message.error?.message ?? '').slice(0, 500)}\n`,
    );
    done(message.result?.exitCode === 0, message.result?.exitCode === 0 ? 'pass' : 'read-denied');
  }
});

send({
  method: 'initialize',
  id: 0,
  params: {
    clientInfo: { name: 'mitzo_readonly_probe', title: 'Mitzo read-only probe', version: '1.0.0' },
    capabilities: { experimentalApi: true },
  },
});
