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
    initializationContract: 'reviewed-image:998:998',
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
it('retains uncertain create identity without treating matching labels as initialization proof', async () => {
  const f = fixture();
  f.host.create.mockRejectedValueOnce(new Error('unknown completion'));
  expect((await f.store.ensure('session')).state).toBe('recovery_required');
  expect(f.store.getReady('session')).toBeNull();
  const [name, labels] = f.host.create.mock.calls[0];
  expect((await f.store.ensure('session')).state).toBe('recovery_required');
  expect(f.host.create).toHaveBeenCalledOnce();
  f.volumes.set(name, { name, labels, driver: 'local', options: {} });
  expect((await f.store.ensure('session')).state).toBe('recovery_required');
  expect(f.store.getReady('session')).toBeNull();
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
it('does not revoke newly ready mapping using a delayed creating-state inspection', async () => {
  const f = fixture();
  let finishCreate!: () => void;
  let finishInspect!: (value: null) => void;
  const creating = new Promise<void>((resolve) => {
    finishCreate = resolve;
  });
  f.host.create.mockImplementationOnce(async (name, labels) => {
    await creating;
    f.volumes.set(name, { name, labels, driver: 'local', options: {} });
  });
  const first = f.store.ensure('session');
  await vi.waitFor(() => expect(f.host.create).toHaveBeenCalledOnce());
  f.host.inspect.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishInspect = resolve;
      }),
  );
  const other = new SymposiumSessionArtifacts(
    join(f.root, 'db'),
    'workspace',
    'custody',
    f.custody,
    f.host,
  );
  cleanup.push(() => other.close());
  const delayed = other.ensure('session');
  finishCreate();
  expect(await first).toEqual({ state: 'ready' });
  const mapping = f.store.getReady('session');
  expect(mapping).not.toBeNull();
  finishInspect(null);
  expect(await delayed).toEqual({ state: 'recovery_required' });
  expect(f.store.getReady('session')).toEqual(mapping);
});
it('does not restore readiness from stale successful inspection after newer contradictory evidence', async () => {
  const f = fixture();
  await f.store.ensure('session');
  const mapping = f.store.getReady('session')!;
  const snapshot = structuredClone(f.volumes.get(mapping.volumeName)!);
  let release!: (v: ArtifactVolumeEvidence) => void;
  f.host.inspect.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const other = new SymposiumSessionArtifacts(
    join(f.root, 'db'),
    'workspace',
    'custody',
    f.custody,
    f.host,
  );
  cleanup.push(() => other.close());
  const stale = other.ensure('session');
  f.volumes.get(mapping.volumeName)!.labels['mitzo.symposium.session'] = 'wrong';
  expect(await f.store.ensure('session')).toEqual({ state: 'recovery_required' });
  release(snapshot);
  expect(await stale).toEqual({ state: 'recovery_required' });
  expect(f.store.getReady('session')).toBeNull();
});
it('fences an uncertain-ready-uncertain ABA cycle by revision, not state', async () => {
  const f = fixture();
  await f.store.ensure('session');
  const mapping = f.store.getReady('session')!;
  const volume = f.volumes.get(mapping.volumeName)!;
  const valid = structuredClone(volume);
  volume.labels['mitzo.symposium.session'] = 'bad';
  await f.store.ensure('session');
  let release!: (v: ArtifactVolumeEvidence) => void;
  f.host.inspect.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const other = new SymposiumSessionArtifacts(
    join(f.root, 'db'),
    'workspace',
    'custody',
    f.custody,
    f.host,
  );
  cleanup.push(() => other.close());
  const stale = other.ensure('session');
  f.volumes.set(mapping.volumeName, structuredClone(valid));
  expect(await f.store.ensure('session')).toEqual({ state: 'ready' });
  f.volumes.get(mapping.volumeName)!.labels['mitzo.symposium.session'] = 'bad-again';
  expect(await f.store.ensure('session')).toEqual({ state: 'recovery_required' });
  release(valid);
  expect(await stale).toEqual({ state: 'recovery_required' });
  expect(f.store.getReady('session')).toBeNull();
});
it('converges concurrent successful inspections on the current ready mapping', async () => {
  const f = fixture();
  await f.store.ensure('session');
  const mapping = f.store.getReady('session')!;
  const volume = f.volumes.get(mapping.volumeName)!;
  const pending: ((v: ArtifactVolumeEvidence) => void)[] = [];
  f.host.inspect.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
  const other = new SymposiumSessionArtifacts(
    join(f.root, 'db'),
    'workspace',
    'custody',
    f.custody,
    f.host,
  );
  cleanup.push(() => other.close());
  const first = f.store.ensure('session');
  const second = other.ensure('session');
  pending[0](volume);
  expect(await first).toEqual({ state: 'ready' });
  pending[1](volume);
  expect(await second).toEqual({ state: 'ready' });
});
it('waits for terminal initialization before a concurrent inspection can report ready', async () => {
  const f = fixture();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.host.create.mockImplementationOnce(async (name, labels) => {
    f.volumes.set(name, { name, labels, driver: 'local', options: {} });
    await pending;
  });
  const first = f.store.ensure('session');
  await vi.waitFor(() => expect(f.host.create).toHaveBeenCalledOnce());
  const other = new SymposiumSessionArtifacts(
    join(f.root, 'db'),
    'workspace',
    'custody',
    f.custody,
    f.host,
  );
  cleanup.push(() => other.close());
  expect(await other.ensure('session')).toEqual({ state: 'recovery_required' });
  finish();
  expect(await first).toEqual({ state: 'ready' });
  expect(f.host.create).toHaveBeenCalledOnce();
});

it('persists initialization receipt but rejects legacy or mismatched image contracts', async () => {
  const f = fixture();
  expect(await f.store.ensure('session')).toEqual({ state: 'ready' });
  const db = new Database(join(f.root, 'db'));
  expect(
    (
      db.prepare('SELECT initialization_contract FROM symposium_session_artifacts').get() as {
        initialization_contract: string;
      }
    ).initialization_contract,
  ).toBe(f.host.initializationContract);
  db.prepare('UPDATE symposium_session_artifacts SET initialization_contract=NULL').run();
  expect(f.store.getReady('session')).toBeNull();
  expect(await f.store.ensure('session')).toEqual({ state: 'recovery_required' });
  db.prepare('UPDATE symposium_session_artifacts SET initialization_contract=?').run(
    'other-image:998:998',
  );
  expect(await f.store.ensure('session')).toEqual({ state: 'recovery_required' });
  db.close();
  expect(f.host.create).toHaveBeenCalledOnce();
});

it('persists initializer intent and ID before failure and never retries or exposes ready volume', async () => {
  const root = mkdtempSync(join(tmpdir(), 'git-init-receipt-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const volumes = new Map<string, ArtifactVolumeEvidence>();
  const create = vi.fn(async (name, labels, receipt) => {
    volumes.set(name, { name, labels, driver: 'local', options: {} });
    receipt.intent(`${name}-init`);
    receipt.created('a'.repeat(64));
    throw new Error('crash after initializer start');
  });
  const host = {
    initializationContract: 'git-v1',
    initializerRequired: true,
    inspect: async (name: string) => volumes.get(name) ?? null,
    create,
  };
  const store = new SymposiumSessionArtifacts(
    join(root, 'db'),
    'workspace',
    'custody',
    () => {},
    host,
  );
  cleanup.push(() => store.close());
  expect(await store.ensure('session')).toEqual({ state: 'recovery_required' });
  const db = new Database(join(root, 'db'));
  const row = db
    .prepare(
      'SELECT initializer_name,initializer_id,initializer_removed,initialization_contract FROM symposium_session_artifacts',
    )
    .get();
  db.close();
  expect(row).toEqual({
    initializer_name: expect.stringMatching(/-init$/),
    initializer_id: 'a'.repeat(64),
    initializer_removed: 0,
    initialization_contract: null,
  });
  expect(await store.ensure('session')).toEqual({ state: 'recovery_required' });
  expect(store.getReady('session')).toBeNull();
  expect(create).toHaveBeenCalledOnce();
});

it('serializes source import against admission and permanently records permission issuance across connections', async () => {
  const f = fixture();
  await f.store.ensure('import-first');
  await f.store.ensure('admission-first');
  const other = new SymposiumSessionArtifacts(
    join(f.root, 'db'),
    'workspace',
    'custody',
    f.custody,
    f.host,
  );
  cleanup.push(() => other.close());
  const request = {
    operationId: 'operation',
    expectedGeneration: f.store.getReady('import-first')!.volumeGeneration,
    source: { commit: 'a'.repeat(40) },
  };
  const claim = f.store.beginSourceImport('import-first', request);
  expect(() => other.claimAdmission('import-first')).toThrow(/source import/);
  expect(other.getReady('import-first')).toBeNull();
  expect(() => other.beginSourceImport('import-first', request)).toThrow(/source import/);
  expect((await other.ensure('import-first')).state).toBe('recovery_required');
  expect(() => other.claimAdmission('import-first')).toThrow(/source import/);
  const helper = f.store.sourceImportHelperReceipt(claim);
  helper.intent(`${claim.volumeName}-import`);
  helper.created('b'.repeat(64));
  helper.removed();
  f.store.completeSourceImport(claim, { commit: 'a'.repeat(40), helperRemoved: true });
  expect(other.claimAdmission('import-first')).toEqual(f.store.getReady('import-first'));
  const issued = other.claimAdmission('admission-first');
  expect(() =>
    f.store.beginSourceImport('admission-first', {
      ...request,
      expectedGeneration: issued.volumeGeneration,
    }),
  ).toThrow(/admission/);
  expect(f.store.sourceImportStatus('admission-first')).toMatchObject({
    available: false,
    admissionIssued: true,
  });
  expect(() => f.store.completeSourceImport({ ...claim, token: 'wrong' }, {})).toThrow(/claim/);
});

it('durably fences original source admission before an imported generation can be sealed', async () => {
  const f = fixture();
  await f.store.ensure('source');
  const mapping = f.store.getReady('source')!;
  const claim = f.store.beginSourceImport('source', {
    operationId: 'import-op',
    expectedGeneration: mapping.volumeGeneration,
    source: {},
  });
  const helper = f.store.sourceImportHelperReceipt(claim);
  helper.intent(`${mapping.volumeName}-import`);
  helper.created('a'.repeat(64));
  helper.removed();
  const receipt = {
    commit: 'b'.repeat(40),
    tree: 'c'.repeat(40),
    featureBranch: 'change',
    bundleSha256: 'd'.repeat(64),
    files: 1,
    bytes: 3,
    git: {
      version: 1,
      commit: 'b'.repeat(40),
      tree: 'c'.repeat(40),
      entries: 1,
      bytes: 3,
      manifestDigest: 'e'.repeat(64),
      committedTreeDigest: 'f'.repeat(64),
    },
    terminal: { helperId: 'a'.repeat(64), exitCode: 0 },
    importer: 'g'.repeat(64),
    operationId: 'import-op',
  };
  f.store.completeSourceImport(claim, receipt);
  const pending = f.store.beginSourceSeal('source', 'source-seal-op');
  expect(pending).toMatchObject({
    sessionId: 'source',
    volumeGeneration: mapping.volumeGeneration,
    sourceReceipt: receipt,
  });
  expect(() => f.store.claimAdmission('source')).toThrow(/source seal/);
  const reopened = new SymposiumSessionArtifacts(
    join(f.root, 'db'),
    'workspace',
    'custody',
    f.custody,
    f.host,
  );
  cleanup.push(() => reopened.close());
  expect(reopened.beginSourceSeal('source', 'source-seal-op')).toEqual(pending);
  expect(() => reopened.claimAdmission('source')).toThrow(/source seal/);
  expect(() => reopened.beginSourceSeal('source', 'other')).toThrow(/source seal/);
});

it('keeps interrupted source import fenced after reopening and rejects stale volume selection', async () => {
  const f = fixture();
  await f.store.ensure('session');
  expect(() =>
    f.store.beginSourceImport('session', {
      operationId: 'old',
      expectedGeneration: 'wrong',
      source: {},
    }),
  ).toThrow(/generation/);
  f.store.beginSourceImport('session', {
    operationId: 'import',
    expectedGeneration: f.store.getReady('session')!.volumeGeneration,
    source: {},
  });
  const reopened = new SymposiumSessionArtifacts(
    join(f.root, 'db'),
    'workspace',
    'custody',
    f.custody,
    f.host,
  );
  cleanup.push(() => reopened.close());
  expect(reopened.getReady('session')).toBeNull();
  expect(() => reopened.claimAdmission('session')).toThrow(/source import/);
  expect(reopened.sourceImportStatus('session')).toMatchObject({
    available: false,
    state: 'recovery_required',
  });
});

it('exposes only retained initialized helper cleanup as initial generation proof', async () => {
  const f = fixture();
  await f.store.ensure('session');
  expect(f.store.initializationReceipt('session')).toBeNull();
  const db = new Database(join(f.root, 'db'));
  const mapping = f.store.getReady('session')!;
  db.prepare(
    'UPDATE symposium_session_artifacts SET initializer_name=?,initializer_id=?,initializer_removed=1 WHERE session_id=?',
  ).run(`${mapping.volumeName}-init`, 'a'.repeat(64), 'session');
  expect(f.store.initializationReceipt('session')).toMatchObject({
    mapping,
    contract: f.host.initializationContract,
    helper: { name: `${mapping.volumeName}-init`, id: 'a'.repeat(64), removed: true },
  });
  const immutableReceipt = f.store.initializationReceipt('session');
  await f.store.ensure('session');
  expect(f.store.initializationReceipt('session')).toEqual(immutableReceipt);
  db.prepare('UPDATE symposium_session_artifacts SET initializer_removed=0').run();
  expect(f.store.initializationReceipt('session')).toBeNull();
  db.close();
});
