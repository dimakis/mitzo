import { expect, it, vi } from 'vitest';
import { OpenShellCheckpointTransport } from '../openshell-checkpoint-transport.js';

it('uses one hashed archive name, verifies before upload, and quotes SSH arguments', async () => {
  const run = vi.fn().mockResolvedValue('{}');
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
    binding: 'binding',
    image: 'image',
    policy: 'policy',
  };
  await transport.capture('/private/tmp/checkpoints', identity, signal);
  await transport.restore('/private/tmp/checkpoints/input.tar', identity, signal);
  const all = run.mock.calls.flatMap((call) => call[1] as string[]).join(' ');
  expect(all).toContain('--gateway-endpoint http://127.0.0.1:8000 --gateway-insecure');
  expect(all).toMatch(/mitzo-[a-f0-9]{64}\.tar/);
  expect(all).not.toContain('a space;$(bad).tar');
  const verify = run.mock.calls.findIndex((call) => call[0] === 'python3');
  const upload = run.mock.calls.findIndex((call) => (call[1] as string[]).includes('upload'));
  expect(verify).toBeLessThan(upload);
  const ssh = run.mock.calls.find((call) => call[0] === 'ssh')![1] as string[];
  expect(ssh.join(' ')).toContain("'thread'\\''s'");
});
