import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createProtectedSdkCommandRunner } from '../protected-sdk-command.js';

afterEach(() => vi.useRealTimers());
function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
    exitCode: null,
    killed: false,
    off: EventEmitter.prototype.off,
  });
  const spawn = vi.fn(() => child as never);
  const run = createProtectedSdkCommandRunner({ spawnClaudeCodeProcess: spawn });
  const options = { cwd: '/synthetic/work', env: { VALUE: 'synthetic value' }, timeout: 5000 };
  return { child, spawn, run, options };
}
it('retains exact argv/env/stdin and both output streams without executing in the controller', async () => {
  const { child, spawn, run, options } = fixture();
  const promise = run('/bin/sh', ['-c', "printf '$VALUE'"], {
    ...options,
    input: 'synthetic input',
  });
  expect(spawn).toHaveBeenCalledWith(
    expect.objectContaining({
      command: '/bin/sh',
      args: ['-c', "printf '$VALUE'"],
      cwd: options.cwd,
      env: options.env,
      captureStderr: true,
      signal: expect.any(AbortSignal),
    }),
  );
  expect(child.stdin.read().toString()).toBe('synthetic input');
  child.stdout.write('output');
  child.stderr.write('diagnostic');
  child.emit('close', 0, null);
  await expect(promise).resolves.toEqual({ stdout: 'output', stderr: 'diagnostic' });
});
it('retains failed status and captured diagnostics', async () => {
  const { child, run, options } = fixture();
  const promise = run('synthetic', [], options);
  child.stdout.write('partial');
  child.stderr.write('reason');
  child.emit('close', 7, null);
  await expect(promise).rejects.toMatchObject({ code: 7, stdout: 'partial', stderr: 'reason' });
});
it('cancels the owned process group on timeout and retains partial output', async () => {
  vi.useFakeTimers();
  const { child, spawn, run, options } = fixture();
  const promise = run('synthetic', [], { ...options, timeout: 200 });
  const assertion = expect(promise).rejects.toMatchObject({
    code: 'ETIMEDOUT',
    stdout: 'partial',
    killed: true,
  });
  child.stdout.write('partial');
  await vi.advanceTimersByTimeAsync(200);
  await assertion;
  expect(spawn.mock.calls[0][0].signal.aborted).toBe(true);
});
it.each(['stdout', 'stderr'] as const)(
  'bounds %s capture and aborts the protected worker',
  async (stream) => {
    const { child, spawn, run, options } = fixture();
    const promise = run('synthetic', [], { ...options, maxBuffer: 4 });
    child[stream].write('12345');
    await expect(promise).rejects.toMatchObject({
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      [stream]: '1234',
    });
    expect(spawn.mock.calls[0][0].signal.aborted).toBe(true);
  },
);
it('propagates session cancellation and refuses an already aborted command', async () => {
  const { spawn, run, options } = fixture();
  const controller = new AbortController();
  const promise = run('synthetic', [], { ...options, signal: controller.signal });
  controller.abort();
  await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  expect(spawn.mock.calls[0][0].signal.aborted).toBe(true);
  await expect(
    run('synthetic', [], { ...options, signal: controller.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(spawn).toHaveBeenCalledOnce();
});
it('returns spawn failure and rejects invalid limits before executing', async () => {
  const { spawn, run, options } = fixture();
  spawn.mockImplementation(() => {
    throw new Error('unavailable boundary');
  });
  await expect(run('synthetic', [], options)).rejects.toThrow('unavailable boundary');
  await expect(run('synthetic', [], { ...options, timeout: 0 })).rejects.toThrow('limits');
  await expect(run('synthetic', [], { ...options, maxBuffer: -1 })).rejects.toThrow('limits');
  expect(spawn).toHaveBeenCalledOnce();
});
