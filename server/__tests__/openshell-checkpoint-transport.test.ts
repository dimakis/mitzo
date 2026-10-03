import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { OpenShellCheckpointTransport } from '../openshell-checkpoint-transport.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const checkpointIdentity = {
  conversation: 'conversation',
  thread: 'thread',
  binding: 'binding',
  image: 'image',
  policy: 'policy',
  sandboxId: 'sandbox',
  resourceVersion: '1',
  accountProvider: 'account',
  accountId: 'account',
  provider: 'openai',
  model: 'model',
  profileRevision: 'r1',
  runtimeScope: 'scope',
  routeKind: 'api' as const,
  routeProvider: 'openai',
};
const checkpointManifest = JSON.stringify({
  version: 1,
  digest: 'a'.repeat(64),
  helper: 'mitzo-checkpoint-v1',
  ...checkpointIdentity,
});
const checkpointRuntime = {
  sandboxName: 'mitzo-x',
  workdir: '/sandbox/workspaces/mgmt',
  appServerCommand: '/sandbox/run-mitzo-app-server' as const,
  cli: 'openshell',
  gateway: 'g',
  workspace: 'w',
  gatewayInsecure: false,
};
function cleanupCalls(run: { mock: { calls: unknown[][] } }) {
  return run.mock.calls.filter(
    ([command, args]) =>
      command === 'ssh' &&
      Array.isArray(args) &&
      args.at(-1)?.includes("'rm' '-f' '--' '/sandbox/mitzo-"),
  );
}

it('uses one hashed archive name, verifies before upload, and quotes SSH arguments', async () => {
  const manifest = JSON.stringify({
    version: 1,
    digest: 'a'.repeat(64),
    helper: 'mitzo-checkpoint-v1',
    conversation: 'a space;$(bad)',
    thread: "thread's",
    binding: '["account","openai","model","revision"]',
    image: 'image',
    policy: 'policy',
    sandboxId: 'sandbox',
    resourceVersion: '1',
    accountProvider: 'account',
    accountId: "id@tenant:$(not-run)\nwith'quote",
    provider: 'openai',
    model: 'model',
    profileRevision: 'r1',
    runtimeScope: 'scope',
    routeKind: 'api',
    routeProvider: 'openai/route;$(not-run)',
  });
  const run = vi.fn(async (_command: string, args: readonly string[]) => {
    if (args.includes('download')) writeFileSync(args.at(-1)!, 'mock');
    return manifest;
  });
  const transport = new OpenShellCheckpointTransport(
    {
      sandboxName: 'mitzo-x',
      workdir: '/sandbox/workspaces/mgmt',
      appServerCommand: '/sandbox/run-mitzo-app-server',
      cli: 'openshell',
      gateway: 'g',
      workspace: 'w',
      gatewayEndpoint: 'http://127.0.0.1:8000',
      gatewayInsecure: true,
    },
    run,
  );
  const signal = new AbortController().signal;
  const identity = {
    conversation: 'a space;$(bad)',
    thread: "thread's",
    binding: '["account","openai","model","revision"]',
    image: 'image',
    policy: 'policy',
    sandboxId: 'sandbox',
    resourceVersion: '1',
    accountProvider: 'account',
    accountId: "id@tenant:$(not-run)\nwith'quote",
    provider: 'openai',
    model: 'model',
    profileRevision: 'r1',
    runtimeScope: 'scope',
    routeKind: 'api' as const,
    routeProvider: 'openai/route;$(not-run)',
  };
  const destination = mkdtempSync(join(tmpdir(), 'checkpoint-transport-'));
  roots.push(destination);
  await transport.capture(destination, identity, signal);
  await transport.restore(join(destination, 'input.tar'), identity, 'a'.repeat(64), signal);
  const all = run.mock.calls.flatMap((call) => call[1] as string[]).join(' ');
  const ssh = run.mock.calls.find((call) => call[0] === 'ssh')![1] as string[];
  const remote = ssh.at(-1)!;
  expect(all).toContain('--gateway-endpoint http://127.0.0.1:8000 --gateway-insecure');
  expect(all).toMatch(/mitzo-[a-f0-9]{64}\.tar/);
  expect(all).toContain('/sandbox/mitzo-');
  // The staging file is intentionally local and can live under the checkout's
  // system temp root. Only the generated remote archive must stay in /sandbox.
  expect(remote).not.toContain('/tmp/mitzo-');
  expect(all).not.toContain('a space;$(bad).tar');
  const verify = run.mock.calls.findIndex((call) => call[0] === '/usr/bin/python3');
  const upload = run.mock.calls.findIndex((call) => (call[1] as string[]).includes('upload'));
  expect(verify).toBeLessThan(upload);
  expect(remote).toContain('\'["account","openai","model","revision"]\'');
  expect(remote).toContain("'thread'\\''s'");
  expect(remote).toContain("'id@tenant:$(not-run)\nwith'\\''quote'");
  expect(remote).toContain("'openai/route;$(not-run)'");
  expect(cleanupCalls(run)).toHaveLength(2);
  for (const [, args] of cleanupCalls(run)) {
    expect((args as string[]).at(-1)).toMatch(
      /'rm' '-f' '--' '\/sandbox\/mitzo-[a-f0-9]{64}\.tar'/,
    );
  }
});

it('removes the exact remote archive after capture download and verification failures', async () => {
  const destination = mkdtempSync(join(tmpdir(), 'checkpoint-transport-download-failure-'));
  roots.push(destination);
  const downloadFailure = vi.fn(async (_command: string, args: readonly string[]) => {
    if (args.includes('download')) throw new Error('download failed');
    return checkpointManifest;
  });
  await expect(
    new OpenShellCheckpointTransport(checkpointRuntime, downloadFailure).capture(
      destination,
      checkpointIdentity,
      new AbortController().signal,
    ),
  ).rejects.toThrow('download failed');
  expect(cleanupCalls(downloadFailure)).toHaveLength(1);

  const verificationFailure = vi.fn(async (command: string, args: readonly string[]) => {
    if (args.includes('download')) writeFileSync(args.at(-1)!, 'invalid archive');
    return command === '/usr/bin/python3' ? 'not json' : checkpointManifest;
  });
  await expect(
    new OpenShellCheckpointTransport(checkpointRuntime, verificationFailure).capture(
      destination,
      checkpointIdentity,
      new AbortController().signal,
    ),
  ).rejects.toThrow('checkpoint helper returned invalid JSON');
  expect(cleanupCalls(verificationFailure)).toHaveLength(1);
  expect(readdirSync(destination)).toEqual([]);
});

it('removes the uploaded remote archive after restore success and failure', async () => {
  const success = vi.fn(async () => checkpointManifest);
  await expect(
    new OpenShellCheckpointTransport(checkpointRuntime, success).restore(
      '/private/tmp/checkpoint.tar',
      checkpointIdentity,
      'a'.repeat(64),
      new AbortController().signal,
    ),
  ).resolves.toBeUndefined();
  expect(cleanupCalls(success)).toHaveLength(1);

  const failure = vi.fn(async (command: string, args: readonly string[]) => {
    if (command === 'ssh' && args.at(-1)?.includes("'restore'")) throw new Error('restore failed');
    return checkpointManifest;
  });
  await expect(
    new OpenShellCheckpointTransport(checkpointRuntime, failure).restore(
      '/private/tmp/checkpoint.tar',
      checkpointIdentity,
      'a'.repeat(64),
      new AbortController().signal,
    ),
  ).rejects.toThrow('restore failed');
  expect(cleanupCalls(failure)).toHaveLength(1);
});

it('surfaces cleanup-only failures without masking the operation failure', async () => {
  const destination = mkdtempSync(join(tmpdir(), 'checkpoint-transport-cleanup-failure-'));
  roots.push(destination);
  const cleanupOnlyFailure = vi.fn(async (command: string, args: readonly string[]) => {
    if (command === 'ssh' && args.at(-1)?.includes("'rm' '-f' '--'"))
      throw new Error('cleanup failed');
    if (args.includes('download')) writeFileSync(args.at(-1)!, 'archive');
    return checkpointManifest;
  });
  await expect(
    new OpenShellCheckpointTransport(checkpointRuntime, cleanupOnlyFailure).capture(
      destination,
      checkpointIdentity,
      new AbortController().signal,
    ),
  ).rejects.toThrow('cleanup failed');

  const primaryDestination = mkdtempSync(join(tmpdir(), 'checkpoint-transport-primary-failure-'));
  roots.push(primaryDestination);
  const primaryFailure = vi.fn(async (command: string, args: readonly string[]) => {
    if (command === 'ssh' && args.at(-1)?.includes("'rm' '-f' '--'"))
      throw new Error('cleanup failed');
    if (args.includes('download')) throw new Error('download failed');
    return checkpointManifest;
  });
  await expect(
    new OpenShellCheckpointTransport(checkpointRuntime, primaryFailure).capture(
      primaryDestination,
      checkpointIdentity,
      new AbortController().signal,
    ),
  ).rejects.toThrow('download failed');
});

it('rejects an archive whose verified digest differs from the persisted checkpoint', async () => {
  const manifest = JSON.stringify({
    version: 1,
    digest: 'a'.repeat(64),
    helper: 'mitzo-checkpoint-v1',
    conversation: 'conversation',
    thread: 'thread',
    binding: 'binding',
    image: 'image',
    policy: 'policy',
    sandboxId: 'sandbox',
    resourceVersion: '1',
    accountProvider: 'account',
    accountId: 'account',
    provider: 'openai',
    model: 'model',
    profileRevision: 'r1',
    runtimeScope: 'scope',
    routeKind: 'api',
    routeProvider: 'openai',
  });
  const run = vi.fn(async (_command: string, _args: readonly string[]) => manifest);
  const transport = new OpenShellCheckpointTransport(
    {
      sandboxName: 'mitzo-x',
      workdir: '/sandbox/workspaces/mgmt',
      appServerCommand: '/sandbox/run-mitzo-app-server',
      cli: 'openshell',
      gateway: 'g',
      workspace: 'w',
      gatewayInsecure: false,
    },
    run,
  );
  const identity = {
    conversation: 'conversation',
    thread: 'thread',
    binding: 'binding',
    image: 'image',
    policy: 'policy',
    sandboxId: 'sandbox',
    resourceVersion: '1',
    accountProvider: 'account',
    accountId: 'account',
    provider: 'openai',
    model: 'model',
    profileRevision: 'r1',
    runtimeScope: 'scope',
    routeKind: 'api' as const,
    routeProvider: 'openai',
  };

  await expect(
    transport.restore(
      '/private/tmp/checkpoint.tar',
      identity,
      'b'.repeat(64),
      new AbortController().signal,
    ),
  ).rejects.toThrow('checkpoint digest does not match record');
  expect(run.mock.calls.some(([, args]) => args.includes('upload'))).toBe(false);
});

it('executes the accepted host helper with isolated fixed Python instead of either image helper', async () => {
  const destination = mkdtempSync(join(tmpdir(), 'checkpoint-host-helper-'));
  roots.push(destination);
  const run = vi.fn(async (_command: string, args: readonly string[]) => {
    if (args.includes('download')) writeFileSync(args.at(-1)!, 'mock archive');
    return checkpointManifest;
  });
  const transport = new OpenShellCheckpointTransport(checkpointRuntime, run);
  const captured = await transport.capture(
    destination,
    checkpointIdentity,
    new AbortController().signal,
  );
  await transport.restore(
    captured.path,
    checkpointIdentity,
    'a'.repeat(64),
    new AbortController().signal,
  );
  const remote = run.mock.calls.filter(
    ([binary, args]) => binary === 'ssh' && !args.at(-1)?.includes("'rm' '-f'"),
  );
  expect(remote).toHaveLength(2);
  for (const [, args] of remote) {
    expect(args.at(-1)).not.toContain('/sandbox/mitzo-checkpoint.py');
    expect(args.at(-1)).toContain("'/usr/bin/python3' '-I' '-c'");
    expect(args.at(-1)).toContain('mitzo-host-checkpoint.py');
    expect(args.at(-1)).toContain('hashlib.sha256');
  }
  const local = run.mock.calls.filter(([binary]) => binary === '/usr/bin/python3');
  expect(local).toHaveLength(2);
  for (const [, args] of local) {
    expect(args.slice(0, 2)).toEqual(['-I', '-c']);
    const bytes = Buffer.from(args[3]!, 'base64');
    expect(bytes.toString()).toContain('def git_config(path):');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(args[4]);
    expect(args[5]).toBe('verify');
  }
});

it('rejects substituted helper bytes before the isolated Python bootstrap executes them', async () => {
  const run = vi.fn(async (_command: string, _args: readonly string[]) => checkpointManifest);
  await new OpenShellCheckpointTransport(checkpointRuntime, run).verify(
    '/private/tmp/nonexistent.tar',
    checkpointIdentity,
    new AbortController().signal,
  );
  const args = [...run.mock.calls[0]![1]];
  args[3] = Buffer.from('raise RuntimeError("untrusted-code-executed")').toString('base64');
  expect(() =>
    execFileSync('/usr/bin/python3', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
  ).toThrow(/checkpoint host helper digest mismatch/);
});
