import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
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
  /** Optional target environment; bootstrap always runs with a trusted host environment. */
  env?: NodeJS.ProcessEnv;
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
    // The outer shell starts before the OS sandbox. Transfer target argv/env
    // over a dedicated pipe to a tiny launcher AFTER crossing that boundary.
    // Neither provider secrets nor injected loader variables enter bootstrap
    // environment, shell arguments, SRT command attribution or violation logs.
    const quote = (part: string) => "'" + part.replaceAll("'", "'\\''") + "'";
    const launcher = `
      const net = require('node:net'), cp = require('node:child_process');
      const transfer = new net.Socket({ fd: 3, readable: true, writable: false });
      const chunks = [];
      let bytes = 0;
      transfer.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 1048576) { process.stderr.write('SDK launch payload exceeds its limit\\n'); process.exit(1); }
        chunks.push(chunk);
      });
      transfer.once('error', error => { process.stderr.write(error.message + '\\n'); process.exit(1); });
      transfer.once('end', () => {
      transfer.destroy();
      let target;
      try {
        target = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!target || typeof target.command !== 'string' || !target.command ||
            !target.env || typeof target.env !== 'object' || Array.isArray(target.env) ||
            Object.values(target.env).some(value => typeof value !== 'string'))
          throw new Error('Invalid SDK launch payload');
      } catch { process.stderr.write('Invalid SDK launch payload\\n'); process.exit(1); }
      for (const name of ${JSON.stringify(['SANDBOX_RUNTIME', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'GRPC_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'grpc_proxy', 'GIT_SSH_COMMAND', 'GIT_CONFIG_PARAMETERS', 'JAVA_TOOL_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE'])})
        if (process.env[name] !== undefined) target.env[name] = process.env[name];
      const child = cp.spawn('/bin/sh', ['-c', target.command], { env: target.env, stdio: 'inherit' });
      child.once('error', error => { process.stderr.write(error.message + '\\n'); process.exit(1); });
      child.once('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
      });
    `;
    const command = payload.env
      ? [process.execPath, '-e', launcher].map(quote).join(' ')
      : payload.command;
    const wrapped = await manager.wrapWithSandbox(command, undefined, undefined, undefined, {
      commandId: randomUUID(),
    });
    // Wrapping initializes network/mount policy asynchronously. Recheck only
    // after it completes, with no await before the actual sandboxed command spawn.
    authority.verify();
    return await new Promise<number>((resolve, reject) => {
      const child = spawnCommand('/bin/sh', ['-c', wrapped], {
        cwd: payload.cwd,
        detached: false,
        stdio: payload.env ? ['inherit', 'inherit', 'inherit', 'pipe'] : 'inherit',
        env: process.env,
      });
      child.once('error', reject);
      if (payload.env) {
        const transfer = child.stdio[3] as Writable;
        transfer.on('error', () => {});
        transfer.end(JSON.stringify({ command: payload.command, env: payload.env }));
      }
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
