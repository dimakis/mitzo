import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { CodexAppServerClient, openShellSshArgvProcessSpec } from './codex-app-server-client.js';
import type { DiscoveryConfig, DiscoveryOperations } from './symposium-model-discovery.js';

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
): Promise<unknown> {
  return new Promise((resolve, reject) =>
    execFile(
      command,
      [...args],
      { env, timeout, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        if (error) return reject(new Error('Discovery host operation failed'));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('Invalid discovery host response'));
        }
      },
    ),
  );
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
function rows(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') throw new Error('Invalid inventory');
  const envelope = value as Record<string, unknown>;
  if (envelope.next_page_token || !Array.isArray(envelope[key]))
    throw new Error('Incomplete inventory');
  return envelope[key];
}
/** ESM host adapter. Caller must supply the retained owned-gateway attestation capability. */
export function createDiscoveryHostOperations(
  config: DiscoveryConfig,
  options: DiscoveryHostOptions,
): DiscoveryOperations {
  if (
    ![options.cli, options.podman, options.policy, options.journal].every(isAbsolute) ||
    !options.configPins.length ||
    !/^[A-Za-z0-9_-]+$/.test(options.namespace)
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
  const cli = (args: string[], timeout?: number) =>
    jsonCommand(options.cli, args, environment, timeout);
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
  return {
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
      if (exclusive) {
        await writeFile(options.journal, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
        return;
      }
      const temporary = `${options.journal}.${randomBytes(8).toString('hex')}`;
      await writeFile(temporary, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
      await rename(temporary, options.journal);
    },
    async clearReceipt() {
      await unlink(options.journal);
    },
    async list() {
      return rows(await cli(['sandbox', ...base, 'list', '--output', 'json']), 'sandboxes');
    },
    async create(receipt) {
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
          `mitzo.discovery.claim=${receipt.claim}`,
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
      );
    },
    async attachedProviders(receipt) {
      return rows(
        await cli(['sandbox', ...base, 'provider', 'list', receipt.name, '--output', 'json']),
        'providers',
      );
    },
    async providerInventory() {
      return rows(
        await cli(['provider', ...base, 'list', '--output', 'json', '--page-size', '100']),
        'providers',
      );
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
        env: spec.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // No lifecycle: CodexAppServerClient itself rejects thread/turn/inference requests.
      const client = new CodexAppServerClient(child, { timeoutMs: 30000 });
      return {
        initialize: () => client.initialize(),
        request: (method, params) => client.request(method, params),
        close: () => {
          client.close();
          child.kill();
        },
      };
    },
    async cancel(receipt) {
      const spec = ssh(receipt.name, [
        '/usr/local/bin/symposium-attempt-controller',
        'cancel',
        receipt.claim,
      ]);
      await jsonCommand(spec.command, spec.args, spec.env as Record<string, string>);
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
