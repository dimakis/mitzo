'use strict';
// Native manual OAuth fallback after a denied callback bind requires terminal
// stdin. Only this fixed auth command gets a PTY; network restrictions stay intact.
const pty = require('node-pty');
let child;
try {
  child = pty.spawn(process.argv[2], ['auth', 'login', '--claudeai'], {
    name: 'dumb',
    cols: 120,
    rows: 30,
    cwd: process.cwd(),
    env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
  });
} catch (cause) {
  const code = ['ENOENT', 'EACCES', 'EPERM'].includes(cause.code) ? cause.code : 'UNKNOWN';
  process.stderr.write(`CLAUDE_LOGIN_NATIVE_SPAWN_FAILED:${code}\n`);
  process.exit(1);
}
let stopping = false;
let closed = false;
let escalation;
const signalChild = (signal) => {
  if (closed) return;
  try {
    child.kill(signal);
  } catch (cause) {
    if (cause.code !== 'ESRCH') process.stderr.write('CLAUDE_LOGIN_NATIVE_SIGNAL_FAILED\n');
  }
};
const stop = () => {
  if (stopping || closed) return;
  stopping = true;
  signalChild('SIGTERM');
  escalation = setTimeout(() => signalChild('SIGKILL'), 2000);
};
const timeout = setTimeout(stop, 10 * 60_000);
process.stdin.on('data', (chunk) => {
  try {
    child.write(chunk.toString('utf8'));
  } catch {
    process.stderr.write('CLAUDE_LOGIN_NATIVE_INPUT_FAILED\n');
    stop();
  }
});
child.onData((data) => process.stdout.write(data));
process.stdin.on('end', stop);
process.stdin.on('error', stop);
process.stdout.on('error', stop);
process.stderr.on('error', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.onExit(({ exitCode, signal }) => {
  closed = true;
  clearTimeout(timeout);
  clearTimeout(escalation);
  process.stdin.destroy();
  process.exitCode = stopping || signal ? 1 : exitCode;
});
