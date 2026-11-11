'use strict';
// The parent owns the private form; EOF also covers a crashed/killed parent.
// The supervisor owns the CLI lifetime and forwards bytes without retaining codes.
const { spawn } = require('node:child_process');
const child = spawn(process.argv[2], ['auth', 'login', '--claudeai'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stopping = false;
let escalation;
const stop = () => {
  if (stopping || child.exitCode !== null || child.signalCode !== null) return;
  stopping = true;
  child.kill('SIGTERM');
  escalation = setTimeout(() => child.kill('SIGKILL'), 2000);
};
const timeout = setTimeout(stop, 10 * 60_000);
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
process.stdin.on('end', stop);
process.stdin.on('error', stop);
process.stdout.on('error', stop);
process.stderr.on('error', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.stdin.on('error', stop);
child.on('error', (cause) => {
  process.stderr.write(`CLAUDE_LOGIN_NATIVE_SPAWN_FAILED:${cause.code || 'UNKNOWN'}\n`);
  stop();
});
child.on('close', (code) => {
  clearTimeout(timeout);
  clearTimeout(escalation);
  process.stdin.unpipe(child.stdin);
  process.stdin.destroy();
  process.exitCode = stopping ? 1 : (code ?? 1);
});
