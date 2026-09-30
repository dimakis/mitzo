import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  fsyncSync: vi.fn((await original<typeof import('node:fs')>()).fsyncSync),
}));
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalConnections } from '../symposium-personal-connections.js';
const roots: string[] = [];
afterEach(() => {
  vi.mocked(fs.fsyncSync).mockRestore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'personal-slots-'));
  roots.push(root);
  const path = join(root, 'connections.json');
  const adapters = new Map<
    string,
    { invalidate: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }
  >();
  const create = vi.fn((id: string) => {
    const adapter = { invalidate: vi.fn(), disconnect: vi.fn().mockResolvedValue(undefined) };
    adapters.set(id, adapter);
    return adapter;
  });
  const manager = new PersonalConnections(path, create);
  return { path, manager, adapters, create };
}
it('keeps multiple slots independent and fences stale revisions', async () => {
  const { manager, adapters } = setup();
  const a = manager.create('Phone');
  const b = manager.create('Second');
  const lease = manager.begin(a.id, a.revision);
  manager.complete(lease, { email: 'a@example.test', planType: 'plus' });
  expect(manager.list().find((r) => r.id === b.id)?.state).toBe('disconnected');
  expect(() => manager.begin(a.id, a.revision)).toThrow();
  const connected = manager.list()[0];
  await manager.disconnect(a.id, connected.revision);
  expect(adapters.get(a.id)?.invalidate).toHaveBeenCalled();
  expect(manager.list()[0].state).toBe('disconnected');
});
it('stores metadata only and never restores authorization after restart', () => {
  const { manager, path, create } = setup();
  const a = manager.create('Phone');
  const lease = manager.begin(a.id, a.revision);
  manager.complete(lease, { email: 'a@example.test', planType: 'plus' });
  const restarted = new PersonalConnections(path, create);
  expect(restarted.list()[0]).toMatchObject({ id: a.id, state: 'reauth_required' });
  expect(readFileSync(path, 'utf8')).not.toMatch(/access_token|refresh_token|providerId/);
  expect(restarted.activeAdapters()).toEqual([]);
});
it('retains recovery block when physical cleanup fails', async () => {
  const { manager, adapters } = setup();
  const a = manager.create('Phone');
  const lease = manager.begin(a.id, a.revision);
  manager.complete(lease, { email: 'a@example.test', planType: 'plus' });
  adapters.get(a.id)!.disconnect.mockRejectedValueOnce(new Error('attached'));
  await expect(manager.disconnect(a.id, manager.list()[0].revision)).rejects.toThrow();
  expect(manager.list()[0].state).toBe('recovery_required');
  expect(() => manager.begin(a.id, manager.list()[0].revision)).toThrow();
  expect(adapters.get(a.id)!.invalidate).toHaveBeenCalled();
});
it('does not permit an old completion to resurrect disconnected credentials', async () => {
  const { manager } = setup();
  const a = manager.create('Phone');
  const lease = manager.begin(a.id, a.revision);
  manager.fail(lease);
  await manager.disconnect(a.id, manager.list()[0].revision);
  expect(() => manager.complete(lease, { email: 'a@example.test', planType: 'plus' })).toThrow();
  expect(manager.activeAdapters()).toEqual([]);
});

it('requires cancellation instead of disconnecting an allocating login', async () => {
  const { manager } = setup();
  const row = manager.create('Phone');
  manager.begin(row.id, row.revision);
  await expect(manager.disconnect(row.id, manager.list()[0].revision)).rejects.toThrow('Cancel');
  expect(manager.list()[0].state).toBe('connecting');
});

it('serializes catalog discovery against disconnect and retains recovery after an interrupted discovery', async () => {
  const { path, manager: connections, create } = setup();
  const row = connections.create('Personal');
  const login = connections.begin(row.id, row.revision);
  connections.complete(login, { email: 'one@example.test', planType: 'plus' });
  const connected = connections.list()[0];
  const lease = connections.beginDiscovery(connected.id, connected.revision);
  await expect(connections.disconnect(connected.id, lease.revision)).rejects.toThrow();
  expect(() => connections.beginDiscovery(connected.id, lease.revision)).toThrow();
  const restarted = new PersonalConnections(path, create);
  expect(restarted.list()[0].state).toBe('recovery_required');
  connections.finishDiscovery(lease, true);
  expect(connections.list()[0].revision).toBeGreaterThan(lease.revision);
});

it('never clears interrupted login recovery after restart without a live cleanup adapter', async () => {
  const { manager, path, create } = setup();
  const row = manager.create('Phone');
  manager.begin(row.id, row.revision);
  const restarted = new PersonalConnections(path, create);
  const recovered = restarted.list()[0];
  expect(recovered.account).toBeUndefined();
  expect(recovered.state).toBe('recovery_required');
  await expect(restarted.disconnect(recovered.id, recovered.revision)).rejects.toThrow('cleanup');
  expect(restarted.list()[0].state).toBe('recovery_required');
});

it.each(['file', 'directory'] as const)(
  'blocks lifecycle mutation when %s durability cannot be confirmed',
  async (kind) => {
    const { manager, adapters } = setup();
    const row = manager.create('Phone');
    const lease = manager.begin(row.id, row.revision);
    manager.complete(lease, { email: 'a@example.test', planType: 'plus' });
    vi.mocked(fs.fsyncSync).mockImplementation((fd) => {
      if (fs.fstatSync(fd).isDirectory() === (kind === 'directory')) throw new Error('sync failed');
    });
    await expect(manager.disconnect(row.id, manager.list()[0].revision)).rejects.toThrow(
      'persistence',
    );
    expect(adapters.get(row.id)!.disconnect).not.toHaveBeenCalled();
    expect(adapters.get(row.id)!.invalidate).toHaveBeenCalled();
    expect(manager.list()[0].state).toBe('recovery_required');
  },
);
it('syncs the connecting file before rename and the parent before returning its lease', () => {
  const { manager, path } = setup();
  const row = manager.create('Phone');
  const seen: string[] = [];
  vi.mocked(fs.fsyncSync).mockImplementation((fd) => {
    if (fs.fstatSync(fd).isDirectory()) {
      expect(JSON.parse(readFileSync(path, 'utf8'))[0].state).toBe('connecting');
      seen.push('directory');
    } else {
      const contents = Buffer.alloc(fs.fstatSync(fd).size);
      fs.readSync(fd, contents, 0, contents.length, 0);
      expect(JSON.parse(contents.toString('utf8'))[0].state).toBe('connecting');
      expect(JSON.parse(readFileSync(path, 'utf8'))[0].state).toBe('disconnected');
      seen.push('file');
    }
  });
  manager.begin(row.id, row.revision);
  expect(seen).toEqual(['file', 'directory']);
});
