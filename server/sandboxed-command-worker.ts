import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SandboxManager,
  SandboxRuntimeConfigSchema,
  type SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime';
import { AuthoritySnapshot, type SerializedAuthority } from './sandbox-authority.js';

export interface SandboxWorkerPayload {
  cwd: string;
  command: string;
  config: SandboxRuntimeConfig;
  authority: SerializedAuthority;
}

interface WorkerDependencies {
  manager: Pick<
    typeof SandboxManager,
    'initialize' | 'wrapWithSandbox' | 'reset' | 'checkDependencies'
  >;
  spawn: typeof spawn;
}

/** Each invocation runs in a fresh trusted process; SRT singleton state is never
 * shared between chats. The parent owns this process group and its time/output limits.
 */
export async function runSandboxedWorker(
  payload: SandboxWorkerPayload,
  dependencies: WorkerDependencies = { manager: SandboxManager, spawn },
): Promise<number> {
  const { manager, spawn: spawnCommand } = dependencies;
  const authority = AuthoritySnapshot.restore(payload.authority);
  const config = SandboxRuntimeConfigSchema.parse(payload.config);
  const dependenciesCheck = manager.checkDependencies();
  if (dependenciesCheck.errors.length || dependenciesCheck.warnings.length)
    throw new Error('Complete OS sandbox dependencies are unavailable');
  try {
    await manager.initialize(config);
    authority.verify();
    const wrapped = await manager.wrapWithSandbox(payload.command);
    // Wrapping initializes network/mount policy asynchronously. Recheck only
    // after it completes, with no await before the actual sandboxed command spawn.
    authority.verify();
    return await new Promise<number>((resolve, reject) => {
      const child = spawnCommand('/bin/sh', ['-c', wrapped], {
        cwd: payload.cwd,
        detached: false,
        stdio: 'inherit',
        env: process.env,
      });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
    });
  } finally {
    await manager.reset();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const payload = JSON.parse(readFileSync(process.argv[2], 'utf8')) as SandboxWorkerPayload;
    process.exitCode = await runSandboxedWorker(payload);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
