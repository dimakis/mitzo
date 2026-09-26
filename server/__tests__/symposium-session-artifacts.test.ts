import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SymposiumSessionArtifacts, artifactVolumeLabels } from '../symposium-session-artifacts.js';
import type { ArtifactVolumeEvidence } from '../symposium-artifact-lease.js';
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'session-artifact-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const volumes = new Map<string, ArtifactVolumeEvidence>();
  const custody = vi.fn();
  const host = {
    inspect: vi.fn(async (name: string) => volumes.get(name) ?? null),
    create: vi.fn(async (name: string, labels: Record<string, string>) => {
      volumes.set(name, { name, labels, driver: 'local', options: {} });
    }),
  };
  const store = new SymposiumSessionArtifacts(
    join(root, 'db'),
    'workspace',
    'custody',
    custody,
    host,
  );
  cleanup.push(() => store.close());
  return { root, store, host, volumes, custody };
}
it('creates one labeled volume and preserves exact identity on concurrent retry', async () => {
  const f = fixture();
  const [first, second] = await Promise.all([f.store.ensure('session'), f.store.ensure('session')]);
  expect(first.state).toBe('ready');
  expect(second).toEqual(first);
  expect(f.host.create).toHaveBeenCalledOnce();
  const mapping = f.store.getReady('session')!;
  expect(f.volumes.get(mapping.volumeName)?.labels).toEqual(
    artifactVolumeLabels('workspace', mapping),
  );
  expect(await f.store.ensure('session')).toEqual(first);
  expect(f.host.create).toHaveBeenCalledOnce();
});
it('retains uncertain create identity and reconciles only matching physical volume', async () => {
  const f = fixture();
  f.host.create.mockRejectedValueOnce(new Error('unknown completion'));
  expect((await f.store.ensure('session')).state).toBe('recovery_required');
  expect(f.store.getReady('session')).toBeNull();
  const [name, labels] = f.host.create.mock.calls[0];
  expect((await f.store.ensure('session')).state).toBe('recovery_required');
  expect(f.host.create).toHaveBeenCalledOnce();
  f.volumes.set(name, { name, labels, driver: 'local', options: {} });
  expect((await f.store.ensure('session')).state).toBe('ready');
  expect(f.host.create).toHaveBeenCalledOnce();
});
it('does not create after custody loss or adopt changed physical labels', async () => {
  const f = fixture();
  f.custody.mockImplementationOnce(() => {
    throw new Error('lost');
  });
  await expect(f.store.ensure('session')).rejects.toThrow('lost');
  expect(f.host.create).not.toHaveBeenCalled();
  await f.store.ensure('session');
  const mapping = f.store.getReady('session')!;
  f.volumes.get(mapping.volumeName)!.labels['mitzo.symposium.session'] = 'other';
  expect((await f.store.ensure('session')).state).toBe('recovery_required');
  expect(f.store.getReady('session')).toBeNull();
});

it('never adopts a preexisting collision on subsequent retries', async () => {
  const f = fixture();
  f.host.inspect.mockImplementation(async (name) => ({
    name,
    driver: 'local',
    options: {},
    labels: {},
  }));
  expect((await f.store.ensure('session')).state).toBe('recovery_required');
  const db = new Database(join(f.root, 'db'));
  const row = db
    .prepare('SELECT volume_name,generation FROM symposium_session_artifacts')
    .get() as { volume_name: string; generation: string };
  db.close();
  f.host.inspect.mockResolvedValue({
    name: row.volume_name,
    driver: 'local',
    options: {},
    labels: artifactVolumeLabels('workspace', {
      sessionId: 'session',
      volumeName: row.volume_name,
      volumeGeneration: row.generation,
    }),
  });
  expect((await f.store.ensure('session')).state).toBe('recovery_required');
  expect(f.host.create).not.toHaveBeenCalled();
});
it('reopens same custody without recreating and rejects a different owner', async () => {
  const f = fixture();
  await f.store.ensure('session');
  const reopened = new SymposiumSessionArtifacts(
    join(f.root, 'db'),
    'workspace',
    'custody',
    f.custody,
    f.host,
  );
  cleanup.push(() => reopened.close());
  expect(await reopened.ensure('session')).toEqual({ state: 'ready' });
  expect(f.host.create).toHaveBeenCalledOnce();
  const alien = new SymposiumSessionArtifacts(
    join(f.root, 'db'),
    'workspace',
    'different',
    f.custody,
    f.host,
  );
  cleanup.push(() => alien.close());
  await expect(alien.ensure('session')).rejects.toThrow('different host custody');
});

it('does not issue another create across concurrent ledger instances', async () => {
  const f = fixture();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.host.create.mockImplementationOnce(async (name, labels) => {
    await pending;
    f.volumes.set(name, { name, labels, driver: 'local', options: {} });
  });
  const other = new SymposiumSessionArtifacts(
    join(f.root, 'db'),
    'workspace',
    'custody',
    f.custody,
    f.host,
  );
  cleanup.push(() => other.close());
  const first = f.store.ensure('session');
  await vi.waitFor(() => expect(f.host.create).toHaveBeenCalledOnce());
  expect(await other.ensure('session')).toEqual({ state: 'recovery_required' });
  finish();
  expect(await first).toEqual({ state: 'ready' });
  expect(await other.ensure('session')).toEqual({ state: 'ready' });
  expect(f.host.create).toHaveBeenCalledOnce();
});
it('retains an uncertain reservation when custody is lost after create', async () => {
  const f = fixture();
  f.host.create.mockImplementationOnce(async (name, labels) => {
    f.volumes.set(name, { name, labels, driver: 'local', options: {} });
    f.custody.mockImplementation(() => {
      throw new Error('custody lost');
    });
  });
  expect(await f.store.ensure('session')).toEqual({ state: 'recovery_required' });
  expect(() => f.store.getReady('session')).toThrow('custody lost');
  await expect(f.store.ensure('session')).rejects.toThrow('custody lost');
  expect(f.host.create).toHaveBeenCalledOnce();
});

it('keeps ready mappings during transport inspection failures for cleanup', async () => {
  const f = fixture();
  await f.store.ensure('session');
  const ready = f.store.getReady('session');
  f.host.inspect.mockRejectedValueOnce(new Error('temporary driver outage'));
  expect(await f.store.ensure('session')).toEqual({ state: 'recovery_required' });
  expect(f.store.getReady('session')).toEqual(ready);
});
