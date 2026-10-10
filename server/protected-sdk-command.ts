import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { ProtectedSdkProcess } from './credential-sdk-boundary.js';

export interface ProtectedSdkCommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
  signal?: AbortSignal;
  input?: string;
  maxBuffer?: number;
}
export type ProtectedSdkCommandRunner = (
  command: string,
  args: string[],
  options: ProtectedSdkCommandOptions,
) => Promise<{ stdout: string; stderr: string }>;

interface Boundary {
  spawnClaudeCodeProcess(options: SpawnOptions & { captureStderr?: boolean }): ProtectedSdkProcess;
}

/** Project callbacks execute in the controller, so explicitly send their command
 * through the same protected worker as the SDK. No shell/env crosses bootstrap. */
export function createProtectedSdkCommandRunner(boundary: Boundary): ProtectedSdkCommandRunner {
  return (command, args, options) => {
    const maxBuffer = options.maxBuffer ?? 1024 * 1024;
    if (
      !Number.isSafeInteger(maxBuffer) ||
      maxBuffer <= 0 ||
      !Number.isFinite(options.timeout) ||
      options.timeout <= 0
    )
      return Promise.reject(new Error('Invalid protected command limits'));
    if (options.signal?.aborted)
      return Promise.reject(new DOMException('Protected command aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let child: ReturnType<Boundary['spawnClaudeCodeProcess']>;
      try {
        child = boundary.spawnClaudeCodeProcess({
          command,
          args,
          cwd: options.cwd,
          env: options.env,
          signal: controller.signal,
          captureStderr: true,
        });
      } catch (error) {
        reject(error);
        return;
      }
      const stdout: Buffer[] = [],
        stderr: Buffer[] = [];
      let stdoutBytes = 0,
        stderrBytes = 0,
        settled = false;
      const text = () => ({
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      });
      const fail = (
        error: Error & { code?: string | number | null; killed?: boolean },
        terminate = true,
      ) => {
        if (settled) return;
        settled = true;
        if (terminate) controller.abort();
        cleanup();
        Object.assign(error, text(), { killed: terminate });
        reject(error);
      };
      const abort = () => fail(new DOMException('Protected command aborted', 'AbortError'));
      const timer = setTimeout(
        () => fail(Object.assign(new Error('Protected command timed out'), { code: 'ETIMEDOUT' })),
        options.timeout,
      );
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      };
      child.stdout.on('data', (data: Buffer) => {
        if (settled) return;
        stdoutBytes += data.length;
        if (stdoutBytes > maxBuffer) {
          stdout.push(data.subarray(0, Math.max(0, maxBuffer - (stdoutBytes - data.length))));
          fail(
            Object.assign(new Error('stdout maxBuffer exceeded'), {
              code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            }),
          );
          return;
        }
        stdout.push(data);
      });
      child.stderr.on('data', (data: Buffer) => {
        if (settled) return;
        stderrBytes += data.length;
        if (stderrBytes > maxBuffer) {
          stderr.push(data.subarray(0, Math.max(0, maxBuffer - (stderrBytes - data.length))));
          fail(
            Object.assign(new Error('stderr maxBuffer exceeded'), {
              code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            }),
          );
          return;
        }
        stderr.push(data);
      });
      child.once('error', fail);
      child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        if (code !== 0 || signal) {
          fail(Object.assign(new Error('Protected command failed'), { code, signal }), false);
          return;
        }
        settled = true;
        cleanup();
        resolve(text());
      });
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) {
        abort();
        return;
      }
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') fail(error);
      });
      child.stdin.end(options.input ?? '');
    });
  };
}
