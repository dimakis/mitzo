import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { openShellSshArgvProcessSpec } from './codex-app-server-client.js';
import {
  controllerClaimDigest,
  type ControlledAttemptSandbox,
} from './symposium-attempt-transport.js';
import type { SymposiumNativeProfileTools } from './symposium-native-profile-tools.js';
export const hostToolPythonFlags = Object.freeze(['-I', '-B', '-S']);
export const hostToolBusScript = readFileSync(
  new URL('../server/symposium-host-tool-bus.py', import.meta.url),
  'utf8',
);
export const hostToolMcpScript = readFileSync(
  new URL('../server/symposium-host-tool-mcp.py', import.meta.url),
  'utf8',
);
export function hostToolBusArgv(claimToken: string, operation: string) {
  return [
    '/usr/bin/python3',
    ...hostToolPythonFlags,
    '-c',
    hostToolBusScript,
    controllerClaimDigest(claimToken),
    operation,
  ];
}
const Calls = z
  .array(
    z.strictObject({
      id: z.string().regex(/^[a-f0-9-]{36}$/),
      name: z.string().min(1).max(128),
      arguments: z.record(z.string(), z.json()),
    }),
  )
  .max(8);
/** Fixed Python transport inside the exact claim HOME. No network endpoint, token or executable comes from a model. */
export async function createSymposiumHostToolBridge(input: {
  sandbox: ControlledAttemptSandbox;
  claimToken: string;
  signal: AbortSignal;
  tools: SymposiumNativeProfileTools;
  verifyCurrent(): void;
}) {
  input.signal.throwIfAborted();
  input.verifyCurrent();
  const digest = controllerClaimDigest(input.claimToken);
  const root = `/sandbox/.symposium-seats/${digest}/host-access`;
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  const run = (operation: string, payload: unknown, currentSignal: AbortSignal = signal) => {
    const spec = openShellSshArgvProcessSpec(
      input.sandbox,
      hostToolBusArgv(input.claimToken, operation),
    );
    return new Promise<string>((resolve, reject) => {
      const child = execFile(
        spec.command,
        spec.args,
        { env: spec.env, signal: currentSignal, timeout: 20_000, maxBuffer: 1024 * 1024 },
        (error, stdout) =>
          error ? reject(new Error('Seat host-tool transport unavailable')) : resolve(stdout),
      );
      child.stdin!.on('error', () => {});
      child.stdin!.end(JSON.stringify(payload));
    });
  };
  await run('setup', { definitions: input.tools.tools, shim: hostToolMcpScript });
  input.verifyCurrent();
  signal.throwIfAborted();
  let closed = false;
  let rejectFailure!: (error: Error) => void;
  const failed = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  void failed.catch(() => {});
  const tasks = new Set<Promise<void>>();
  const fail = () => {
    if (!closed) {
      controller.abort();
      rejectFailure(new Error('Seat host-tool bridge failed or claim changed'));
    }
  };
  let activate!: () => void;
  const activated = new Promise<void>((resolve) => {
    activate = resolve;
  });
  signal.addEventListener('abort', activate, { once: true });
  const loop = (async () => {
    try {
      await activated;
      while (!signal.aborted) {
        input.verifyCurrent();
        const calls = Calls.parse(JSON.parse(await run('take', {})));
        input.verifyCurrent();
        signal.throwIfAborted();
        for (const call of calls) {
          const task = (async () => {
            if (!input.tools.tools.some((tool) => tool.name === call.name))
              throw new Error('Seat host tool unavailable');
            const response = await input.tools.executeTool(call.name, call.arguments, signal, {
              turnId: input.claimToken,
              callId: call.id,
            });
            if (closed || signal.aborted) return;
            input.verifyCurrent();
            await run('put', { id: call.id, response });
          })().catch(fail);
          tasks.add(task);
          void task.finally(() => tasks.delete(task));
        }
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', finish);
            resolve();
          };
          const timer = setTimeout(finish, 250);
          signal.addEventListener('abort', finish, { once: true });
          if (signal.aborted) finish();
        });
      }
    } catch {
      fail();
    }
  })();
  let closing: Promise<void> | undefined;
  return {
    activate: () => {
      signal.throwIfAborted();
      input.verifyCurrent();
      activate();
    },
    failed,
    argv: [
      '--mcp-config',
      JSON.stringify({
        mcpServers: {
          'mitzo-host-access': {
            command: '/usr/bin/python3',
            args: [...hostToolPythonFlags, `${root}/mcp.py`, root],
          },
        },
      }),
      '--allowedTools',
      input.tools.tools.map((tool) => `mcp__mitzo-host-access__${tool.name}`).join(','),
    ],
    close() {
      closing ??= (async () => {
        closed = true;
        controller.abort();
        activate();
        await loop;
        await Promise.allSettled([...tasks]);
        signal.removeEventListener('abort', activate);
        await run('close', {}, AbortSignal.timeout(20_000));
      })();
      return closing;
    },
  };
}
