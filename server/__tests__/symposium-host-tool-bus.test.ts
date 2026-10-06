import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import * as Bridge from '../symposium-host-tool-bridge.js';
import { hostToolBusScript, hostToolMcpScript } from '../symposium-host-tool-bridge.js';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'symposium-host-bus-'));
  roots.push(root);
  const digest = Bridge.hostToolBusArgv('fixture', 'setup')[
    Bridge.hostToolBusArgv('fixture', 'setup').length - 2
  ];
  const code = hostToolBusScript.replaceAll('/sandbox/.symposium-seats', root);
  const run = (operation: string, input: unknown = {}) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile(
        'python3',
        Bridge.hostToolBusArgv('fixture', operation)
          .slice(1)
          .map((value) => (value === hostToolBusScript ? code : value)),
        { maxBuffer: 1024 * 1024, cwd: root, env: { ...process.env, PYTHONPATH: root } },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
      child.stdin!.end(JSON.stringify(input));
    });
  return { root, digest, run, bus: join(root, digest, 'host-access') };
}
it('round-trips an MCP tool call through a bounded claim-private bus without network access or credentials', async () => {
  const f = await fixture();
  const definitions = [
    { name: 'RequestWebAccess', description: 'Read', input_schema: { type: 'object' } },
  ];
  await f.run('setup', { definitions, shim: hostToolMcpScript });
  const child = spawn('python3', [...Bridge.hostToolPythonFlags, join(f.bus, 'mcp.py'), f.bus], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH },
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    }) + '\n',
  );
  child.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'RequestWebAccess',
        arguments: {
          operation: 'request_access',
          url: 'http://localhost:8123/',
          reason: 'Read HA',
        },
      },
    }) + '\n',
  );
  try {
    let calls: Array<{ id: string; name: string; arguments: unknown }> = [];
    for (let tick = 0; tick < 50 && !calls.length; tick++) {
      calls = JSON.parse(await f.run('take'));
      if (!calls.length) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'RequestWebAccess',
      arguments: { url: 'http://localhost:8123/' },
    });
    await f.run('put', {
      id: calls[0].id,
      response: { content: 'Approved by user', isError: false },
    });
    for (let tick = 0; tick < 50 && !output.includes('Approved by user'); tick++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(output).toContain('Approved by user');
    expect(output).not.toContain('Bearer');
  } finally {
    child.kill();
    await f.run('close');
  }
});
it('refuses linked request files instead of reading a path outside the claimed bus', async () => {
  const f = await fixture();
  await f.run('setup', { definitions: [], shim: hostToolMcpScript });
  const outside = join(f.root, 'private');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(outside, 'secret');
  await symlink(outside, join(f.bus, '12345678-1234-1234-1234-123456789abc.request'));
  await expect(f.run('take')).rejects.toThrow();
  expect(await readFile(outside, 'utf8')).toBe('secret');
});

it('ignores hostile workspace Python modules and PYTHONPATH in the controller helper', async () => {
  const f = await fixture();
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(f.root, 'json.py'), "raise RuntimeError('Workspace module executed')\n");
  await expect(f.run('setup', { definitions: [], shim: hostToolMcpScript })).resolves.toContain(
    '{}',
  );
  await f.run('close');
});
