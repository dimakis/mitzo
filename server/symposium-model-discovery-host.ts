import { discoveryClaimLabel } from './symposium-model-discovery.js';
import {
  DiscoveryDiagnosticSchema,
  DiscoveryCommandFailure,
  classifyDiscoveryCommandFailure,
} from './symposium-discovery-diagnostics.js';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { readFile, rename, unlink, open, lstat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import {
  CodexAppServerClient,
  openShellSshArgvProcessSpec,
  terminateOpenShellProcess,
} from './codex-app-server-client.js';
import type {
  DiscoveryConfig,
  DiscoveryOperations,
  DiscoveryReceipt,
} from './symposium-model-discovery.js';

export interface DiscoveryHostOptions {
  cli: string;
  podman: string;
  policy: string;
  journal: string;
  namespace: string;
  /** Exact private management environment; process.env is never inherited. */
  environment: Record<string, string>;
  /** Owned configuration files whose bytes/modes must remain pinned. No secret bytes are logged. */
  configPins: Array<{ path: string; sha256: string; mode: number }>;
  /** Attest the running owned gateway, its effective config/TLS and exact selected provider custody. */
  attestGateway(config: DiscoveryConfig): Promise<void>;
}
function jsonCommand(
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  timeout = 15000,
  processGroup = false,
  beforeDispatch?: () => void,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    beforeDispatch?.();
    const child = execFile(
      command,
      [...args],
      {
        env,
        timeout,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
        ...(processGroup ? { detached: true, shell: false } : {}),
      },
      (error, stdout) => {
        if (processGroup) child?.kill();
        if (error) return reject(classifyDiscoveryCommandFailure(error, child?.pid));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(
            new DiscoveryCommandFailure({
              failureClass: 'invalid-response',
              commandDispatch: 'possibly-started',
            }),
          );
        }
      },
    );
    if (processGroup) {
      const killChild = child.kill.bind(child);
      child.kill = (() =>
        terminateOpenShellProcess({ pid: child.pid, kill: killChild })) as typeof child.kill;
    }
  });
}
async function syncDirectory(path: string) {
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
function privateDirectory(path: string) {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error('Private discovery directory required');
}
function pin(path: string, digest: string, mode?: number) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o022) !== 0 ||
    (mode !== undefined && (stat.mode & 0o777) !== mode) ||
    createHash('sha256').update(readFileSync(path)).digest('hex') !== digest
  )
    throw new Error('Discovery pin changed');
}
/** ESM host adapter. Caller must supply the retained owned-gateway attestation capability. */
export function createDiscoveryHostOperations(
  config: DiscoveryConfig,
  options: DiscoveryHostOptions,
): DiscoveryOperations {
  if (
    ![options.cli, options.podman, options.policy, options.journal].every(isAbsolute) ||
    !options.configPins.length ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(options.namespace)
  )
    throw new Error('Explicit discovery host configuration required');
  const environment = { ...options.environment };
  const required = ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'];
  if (
    Object.keys(environment).length !== required.length ||
    required.some((key) => !environment[key]) ||
    required.slice(1).some((key) => !isAbsolute(environment[key]))
  )
    throw new Error('Private management environment required');
  const base = ['--gateway', config.gateway, '--workspace', config.workspace];
  const cli = async (args: string[], timeout?: number, beforeDispatch?: () => void) => {
    await options.attestGateway(config);
    const result = await jsonCommand(
      options.cli,
      args,
      environment,
      timeout,
      false,
      beforeDispatch,
    );
    await options.attestGateway(config);
    return result;
  };
  const inventory = async (args: string[], key: string): Promise<unknown[]> => {
    const result: unknown[] = [];
    const seen = new Set<string>();
    let token = '';
    for (let page = 0; page < 100; page++) {
      const value = await cli([
        ...args,
        '--output',
        'json',
        '--page-size',
        '100',
        '--page-token',
        token,
      ]);
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid inventory');
      const envelope = value as Record<string, unknown>;
      if (!Array.isArray(envelope[key]) || typeof envelope.next_page_token !== 'string')
        throw new Error('Incomplete inventory');
      result.push(...envelope[key]);
      token = envelope.next_page_token;
      if (!token) return result;
      if (seen.has(token)) throw new Error('Repeated inventory continuation');
      seen.add(token);
    }
    throw new Error('Incomplete inventory page limit');
  };
  const ssh = (name: string, args: string[]) =>
    openShellSshArgvProcessSpec(
      {
        cli: options.cli,
        gateway: config.gateway,
        workspace: config.workspace,
        cliEnvironment: environment,
        sandboxName: name,
        workdir: '/sandbox/workspaces/mgmt',
        gatewayInsecure: false,
      },
      args,
      {},
    );
  let activeAttempt = false;
  let creationDispatched = false;
  let assertAttemptLock: (() => Promise<void>) | undefined;
  const clearExactReceipt = async (expected: DiscoveryReceipt) => {
    if (!activeAttempt || !assertAttemptLock) throw new Error('Journal lock proof required');
    await assertAttemptLock!();
    privateDirectory(dirname(options.journal));
    const stat = await lstat(options.journal);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600
    )
      throw new Error('Unsafe discovery journal');
    const actual = JSON.parse(await readFile(options.journal, 'utf8'));
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error('Discovery journal identity changed');
    const current = await lstat(options.journal);
    if (current.ino !== stat.ino || current.dev !== stat.dev || current.isSymbolicLink())
      throw new Error('Discovery journal identity changed');
    await assertAttemptLock!();
    await unlink(options.journal);
    await syncDirectory(dirname(options.journal));
  };
  return {
    async withExclusiveAttempt(operation) {
      privateDirectory(dirname(options.journal));
      const path = `${options.journal}.lock`;
      const lock = await open(path, 'wx', 0o600);
      const release = async () => {
        try {
          const held = await lock.stat();
          const current = await lstat(path);
          if (held.ino !== current.ino || held.dev !== current.dev || current.isSymbolicLink())
            throw new Error('Discovery journal ownership changed');
          await unlink(path);
        } finally {
          await lock.close();
        }
      };
      try {
        await lock.sync();
        const directory = await open(dirname(path), 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
        activeAttempt = true;
        creationDispatched = false;
        assertAttemptLock = async () => {
          const held = await lock.stat();
          const current = await lstat(path);
          if (held.ino !== current.ino || held.dev !== current.dev || current.isSymbolicLink())
            throw new Error('Discovery journal ownership changed');
        };
        return await operation();
      } finally {
        activeAttempt = false;
        assertAttemptLock = undefined;
        await release();
      }
    },
    async recordDiagnostic(value) {
      if (!activeAttempt || !assertAttemptLock) throw new Error('Journal lock proof required');
      await assertAttemptLock();
      const diagnostic = DiscoveryDiagnosticSchema.parse(value);
      privateDirectory(dirname(options.journal));
      const temporary = `${options.journal}.diagnostic.${randomBytes(8).toString('hex')}`;
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(diagnostic));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, options.journal + '.diagnostic.json');
      await syncDirectory(dirname(options.journal));
    },
    async verifyCustody(expected) {
      if (
        expected.podmanUrl !== config.podmanUrl ||
        expected.cliSha256 !== config.cliSha256 ||
        expected.workloadImage !== config.workloadImage ||
        expected.policySha256 !== config.policySha256 ||
        expected.gateway !== config.gateway ||
        expected.workspace !== config.workspace ||
        expected.provider.id !== config.provider.id ||
        expected.provider.name !== config.provider.name
      )
        throw new Error('Discovery config changed');
      privateDirectory(dirname(options.journal));
      required.slice(1).forEach((key) => privateDirectory(environment[key]));
      pin(options.cli, config.cliSha256);
      pin(options.policy, config.policySha256);
      options.configPins.forEach((item) => pin(item.path, item.sha256, item.mode));
      await options.attestGateway(config);
    },
    async readReceipt() {
      try {
        const stat = lstatSync(options.journal);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.uid !== process.getuid?.() ||
          (stat.mode & 0o777) !== 0o600
        )
          throw new Error('Unsafe discovery journal');
        return JSON.parse(await readFile(options.journal, 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    async persistReceipt(receipt, exclusive) {
      const destination = exclusive
        ? options.journal
        : `${options.journal}.${randomBytes(8).toString('hex')}`;
      const file = await open(destination, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(receipt));
        await file.sync();
      } finally {
        await file.close();
      }
      if (!exclusive) await rename(destination, options.journal);
      await syncDirectory(dirname(options.journal));
    },
    async clearUndispatchedReceipt(expected) {
      if (!activeAttempt || creationDispatched || expected.id)
        throw new Error('Undispatched journal proof required');
      await clearExactReceipt(expected);
    },
    clearReceipt: clearExactReceipt,
    async list() {
      return inventory(['sandbox', ...base, 'list'], 'sandboxes');
    },
    async create(receipt, _config, beforeDispatch) {
      await cli(
        [
          'sandbox',
          ...base,
          'create',
          '--name',
          receipt.name,
          '--from',
          config.workloadImage,
          '--policy',
          options.policy,
          '--provider',
          config.provider.name,
          '--no-auto-providers',
          '--label',
          'mitzo.discovery=models',
          '--label',
          `mitzo.discovery.claim=${discoveryClaimLabel(receipt.claim)}`,
          '--cpu',
          '1',
          '--memory',
          '1Gi',
          '--detach',
          '--output',
          'json',
          '--',
          '/bin/sh',
          '-c',
          'mkdir -p /sandbox/workspaces/mgmt && exec sleep infinity',
        ],
        45000,
        () => {
          beforeDispatch?.();
          creationDispatched = true;
        },
      );
    },
    async attachedProviders(receipt) {
      return inventory(['sandbox', ...base, 'provider', 'list', receipt.name], 'providers');
    },
    async providerInventory() {
      return inventory(['provider', ...base, 'list'], 'providers');
    },
    async openClient(receipt) {
      const spec = ssh(receipt.name, [
        '/usr/local/bin/symposium-attempt-controller',
        'run',
        receipt.claim,
        'read',
        '/usr/local/bin/symposium-subscription-app-server',
      ]);
      const child = spawn(spec.command, spec.args, {
        detached: true,
        shell: false,
        env: spec.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const killChild = child.kill.bind(child);
      child.kill = (() =>
        terminateOpenShellProcess({ pid: child.pid, kill: killChild })) as typeof child.kill;
      // No lifecycle: CodexAppServerClient itself rejects thread/turn/inference requests.
      const client = new CodexAppServerClient(child, { timeoutMs: 30000 });
      return {
        initialize: () => client.initialize(),
        request: (method, params) => client.request(method, params),
        close: () => {
          client.close();
        },
      };
    },
    async cancel(receipt) {
      const spec = ssh(receipt.name, [
        '/usr/local/bin/symposium-attempt-controller',
        'cancel',
        receipt.claim,
      ]);
      await jsonCommand(spec.command, spec.args, spec.env as Record<string, string>, 15000, true);
    },
    async delete(receipt) {
      await cli(['sandbox', ...base, 'delete', receipt.name], 30000);
    },
    async physicalAbsent(receipt) {
      const value = await jsonCommand(
        options.podman,
        ['--url', config.podmanUrl, 'ps', '--all', '--format', 'json'],
        environment,
      );
      if (!Array.isArray(value)) throw new Error('Invalid physical inventory');
      return value.every((row) => {
        const labels = row?.Labels ?? row?.labels;
        if (!labels || typeof labels !== 'object') throw new Error('Missing physical labels');
        const names = Array.isArray(row.Names)
          ? row.Names
          : typeof row.Names === 'string'
            ? [row.Names]
            : [];
        return (
          labels['openshell.ai/sandbox-id'] !== receipt.id &&
          !(
            labels['openshell.ai/sandbox-name'] === receipt.name &&
            labels['openshell.ai/sandbox-workspace'] === config.workspace &&
            labels['openshell.ai/sandbox-namespace'] === options.namespace
          ) &&
          !names.some(
            (name: string) =>
              name === receipt.name ||
              (!!receipt.id && (name === receipt.id || name.endsWith(`-${receipt.id}`))),
          )
        );
      });
    },
    wait: () => new Promise((resolve) => setTimeout(resolve, 1000)),
  };
}
