import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { OpenShellCheckpointTransport } from '../openshell-checkpoint-transport.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
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
  expect(all).toContain('--gateway-endpoint http://127.0.0.1:8000 --gateway-insecure');
  expect(all).toMatch(/mitzo-[a-f0-9]{64}\.tar/);
  expect(all).toContain('/sandbox/mitzo-');
  expect(all).not.toContain('/tmp/mitzo-');
  expect(all).not.toContain('a space;$(bad).tar');
  const verify = run.mock.calls.findIndex((call) => call[0] === 'python3');
  const upload = run.mock.calls.findIndex((call) => (call[1] as string[]).includes('upload'));
  expect(verify).toBeLessThan(upload);
  const ssh = run.mock.calls.find((call) => call[0] === 'ssh')![1] as string[];
  const remote = ssh.at(-1)!;
  expect(remote).toContain('\'["account","openai","model","revision"]\'');
  expect(remote).toContain("'thread'\\''s'");
  expect(remote).toContain("'id@tenant:$(not-run)\nwith'\\''quote'");
  expect(remote).toContain("'openai/route;$(not-run)'");
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
