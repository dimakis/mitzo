import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { openShellSshArgvProcessSpec } from './codex-app-server-client.js';

const controller = '/usr/local/bin/symposium-attempt-controller';
const sharedWorkdir = '/sandbox/workspaces/mgmt';

export interface ControlledAttemptSandbox {
  sandboxName: string;
  workdir: string;
  /** Absent only on legacy durable claims, which cannot be safely recovered. */
  cli?: string;
  gateway?: string;
  workspace?: string;
  gatewayEndpoint?: string;
  gatewayInsecure?: boolean;
}

/** Persist only reviewed non-secret transport routing, never ambient defaults. */
export function controlledAttemptRoute(sandbox: ControlledAttemptSandbox) {
  if (
    typeof sandbox.cli !== 'string' ||
    !sandbox.cli ||
    typeof sandbox.gateway !== 'string' ||
    !sandbox.gateway ||
    typeof sandbox.workspace !== 'string' ||
    !sandbox.workspace ||
    typeof sandbox.gatewayInsecure !== 'boolean' ||
    (sandbox.gatewayEndpoint !== undefined && typeof sandbox.gatewayEndpoint !== 'string')
  )
    throw new Error('Native attempt gateway route is unavailable; reconciliation required');
  if (sandbox.gatewayInsecure && !sandbox.gatewayEndpoint)
    throw new Error('Native attempt insecure gateway requires an explicit endpoint');
  const route = {
    cli: sandbox.cli,
    gateway: sandbox.gateway,
    workspace: sandbox.workspace,
    ...(sandbox.gatewayEndpoint === undefined ? {} : { gatewayEndpoint: sandbox.gatewayEndpoint }),
    gatewayInsecure: sandbox.gatewayInsecure,
  };
  if (sandbox.gatewayEndpoint !== undefined && !sandbox.gatewayEndpoint)
    throw new Error('Native attempt gateway endpoint is invalid');
  // Reuse the established argv validation without spawning any process.
  openShellSshArgvProcessSpec({ ...sandbox, ...route }, ['/usr/bin/true'], {});
  return route;
}

function controlledProcessSpec(sandbox: ControlledAttemptSandbox, argv: readonly string[]) {
  const route = controlledAttemptRoute(sandbox);
  const base = { ...process.env };
  for (const key of [
    'OPENSHELL_GATEWAY',
    'OPENSHELL_GATEWAY_ENDPOINT',
    'OPENSHELL_GATEWAY_INSECURE',
    'OPENSHELL_WORKSPACE',
  ])
    delete base[key];
  return openShellSshArgvProcessSpec({ ...sandbox, ...route }, argv, base);
}

export interface ControlledAttemptProcess {
  child: ChildProcessWithoutNullStreams;
  /** Repeatable after a host restart when the original sandbox and claim are known. */
  confirmStopped(): Promise<void>;
}

export function controllerClaimDigest(claimToken: string): string {
  if (!claimToken || claimToken.length > 256) throw new Error('Invalid native attempt claim');
  return createHash('sha256').update(claimToken).digest('hex');
}

export function controlledAttemptArgv(
  mode: 'run' | 'cancel',
  claimToken: string,
  access?: 'read' | 'write',
  command?: readonly string[],
): string[] {
  const digest = controllerClaimDigest(claimToken);
  if (mode === 'cancel') return [controller, 'cancel', digest];
  if (!access || !command?.length || command.some((arg) => !arg || arg.includes('\0')))
    throw new Error('Invalid controlled native command');
  return [controller, 'run', digest, access, ...command];
}

export function verifyControllerProof(value: string, claimToken: string): void {
  let proof: unknown;
  try {
    proof = JSON.parse(value);
  } catch {
    throw new Error('Native attempt cleanup is unconfirmed');
  }
  if (
    !proof ||
    typeof proof !== 'object' ||
    (proof as Record<string, unknown>).claim !== controllerClaimDigest(claimToken) ||
    (proof as Record<string, unknown>).terminal !== true ||
    !Number.isInteger((proof as Record<string, unknown>).exit_code) ||
    !Number.isInteger((proof as Record<string, unknown>).signal)
  )
    throw new Error('Native attempt cleanup is unconfirmed');
}

/** No inferred success from SSH closure: only the exact controller marker releases a claim. */
export async function confirmControlledAttemptStopped(
  sandbox: ControlledAttemptSandbox,
  claimToken: string,
  spawnProcess = spawn,
): Promise<void> {
  if (sandbox.workdir !== sharedWorkdir)
    throw new Error('Unverified native attempt workspace layout');
  const spec = controlledProcessSpec(sandbox, controlledAttemptArgv('cancel', claimToken));
  const child = spawnProcess(spec.command, spec.args, {
    env: spec.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      fail();
    }, 20_000);
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('Native attempt cleanup is unconfirmed'));
    };
    child.stdout.on('data', (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.length > 512) fail();
    });
    child.on('error', fail);
    child.on('close', (code: number | null) => {
      if (settled) return;
      if (code !== 0) return fail();
      try {
        verifyControllerProof(output, claimToken);
        settled = true;
        clearTimeout(timer);
        resolve();
      } catch {
        fail();
      }
    });
  });
}

/** Launches one exact claim. The controller inherits stdin and streams output. */
export function launchControlledAttempt(
  sandbox: ControlledAttemptSandbox,
  claimToken: string,
  access: 'read' | 'write',
  command: readonly string[],
  spawnProcess = spawn,
): ControlledAttemptProcess {
  if (sandbox.workdir !== sharedWorkdir)
    throw new Error('Unverified native attempt workspace layout');
  const spec = controlledProcessSpec(
    sandbox,
    controlledAttemptArgv('run', claimToken, access, command),
  );
  return {
    child: spawnProcess(spec.command, spec.args, {
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
    confirmStopped: () => confirmControlledAttemptStopped(sandbox, claimToken, spawnProcess),
  };
}
