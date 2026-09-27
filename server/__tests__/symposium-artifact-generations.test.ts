import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  SymposiumArtifactGenerations,
  type ArtifactGenerationIntent,
  type ArtifactGenerationRequest,
} from '../symposium-artifact-generations.js';
import { canonicalReviewJson, reviewRecordHash } from '../symposium-review-records.js';
const dirs: string[] = [];
const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) if (db.open) db.close();
  for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true });
});
const hash = 'a'.repeat(64),
  oid = 'b'.repeat(40);
const context = { sessionId: 'session', workspace: 'workspace', custodyDigest: hash };
const initial = {
  ...context,
  generationId: 'initial',
  volumeName: 'initial-volume',
  initializationReceiptDigest: hash,
};
const request: ArtifactGenerationRequest = {
  ...context,
  operationId: 'operation',
  expectedPointerRevision: 0,
  parentGenerationId: 'initial',
  parentSealDigest: hash,
  parentCommit: oid,
  parentTree: oid,
  parentManifestDigest: hash,
  parentCommittedTreeDigest: hash,
  bundleSha256: hash,
  exportReceiptDigest: hash,
  workflowId: 'workflow',
  fixAttemptId: 'fix',
  actor: 'owner',
  authorityGrantId: 'grant',
  authorityRevision: 1,
  seatId: 'writer',
  membershipGeneration: 1,
  accountId: 'personal',
  model: 'luna-fixture',
  profileId: 'profile',
  profileRevision: '1',
  findingFingerprints: [hash],
  copierImageDigest: hash,
  copierCodeDigest: hash,
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'generation-test-'));
  dirs.push(root);
  const path = join(root, 'ledger.db');
  const proof = {
    initial: vi.fn(() => true as const),
    authority: vi.fn(() => true as const),
    parent: vi.fn(() => true as const),
    copy: vi.fn(() => true as const),
  };
  const open = () => {
    const db = new Database(path);
    dbs.push(db);
    return { db, store: new SymposiumArtifactGenerations(db, proof) };
  };
  return { path, proof, open, ...open() };
}
function receipt(intent: ArtifactGenerationIntent) {
  return {
    intentDigest: reviewRecordHash(canonicalReviewJson(intent)),
    generationId: intent.generationId,
    volumeName: intent.volumeName,
    helperName: intent.helperName,
    helperId: `id-${intent.generationId}`,
    initializationReceiptDigest: hash,
    exportReceiptDigest: hash,
    commit: oid,
    tree: oid,
    manifestDigest: hash,
    committedTreeDigest: hash,
    bundleSha256: hash,
    terminalExitCode: 0 as const,
    helperRemoved: true as const,
    verificationDigest: hash,
  };
}
function prepared() {
  const f = fixture();
  f.store.registerInitial(initial);
  const intent = f.store.reserve(request);
  return { ...f, intent };
}
function copied() {
  const f = prepared();
  f.store.claimCopy(context, f.intent.generationId);
  f.store.bindHelper(context, f.intent.generationId, receipt(f.intent).helperId);
  f.store.recordCopy(context, f.intent.generationId, receipt(f.intent));
  return f;
}
it('keeps parent byte-identical through copy and child pointer activation', () => {
  const f = copied();
  const before = f.store.historical(context, 'initial');
  expect(f.store.active(context)).toEqual({ generationId: 'initial', revision: 0 });
  expect(f.store.activate(context, f.intent.generationId)).toEqual({
    generationId: f.intent.generationId,
    revision: 1,
  });
  expect(f.store.activate(context, f.intent.generationId).revision).toBe(1);
  expect(f.store.historical(context, 'initial')).toEqual(before);
  expect(f.store.historical(context, f.intent.generationId).receipt).toEqual(receipt(f.intent));
});
it('exact registration/reservation/receipt replay is idempotent, changes rejected', () => {
  const f = copied();
  f.store.registerInitial(initial);
  expect(f.store.reserve(request)).toEqual(f.intent);
  f.store.recordCopy(context, f.intent.generationId, receipt(f.intent));
  expect(() => f.store.registerInitial({ ...initial, volumeName: 'other' })).toThrow('conflict');
  expect(() => f.store.reserve({ ...request, model: 'other' })).toThrow('conflict');
  expect(() =>
    f.store.recordCopy(context, f.intent.generationId, {
      ...receipt(f.intent),
      verificationDigest: 'c'.repeat(64),
    }),
  ).toThrow('conflict');
});
it.each(['reserved', 'claimed', 'bound', 'verified', 'activated'] as const)(
  'reopens safely at %s crash boundary',
  (phase) => {
    const f = prepared();
    if (phase !== 'reserved') f.store.claimCopy(context, f.intent.generationId);
    if (['bound', 'verified', 'activated'].includes(phase))
      f.store.bindHelper(context, f.intent.generationId, receipt(f.intent).helperId);
    if (['verified', 'activated'].includes(phase))
      f.store.recordCopy(context, f.intent.generationId, receipt(f.intent));
    if (phase === 'activated') f.store.activate(context, f.intent.generationId);
    f.db.close();
    const reopened = f.open().store;
    expect(reopened.reserve(request)).toEqual(f.intent);
    if (phase === 'reserved') expect(reopened.claimCopy(context, f.intent.generationId)).toBe(true);
    else expect(reopened.claimCopy(context, f.intent.generationId)).toBe(false);
    if (['reserved', 'claimed', 'bound'].includes(phase))
      expect(() => reopened.activate(context, f.intent.generationId)).toThrow('receipt');
    else expect(reopened.activate(context, f.intent.generationId).revision).toBe(1);
  },
);
it('unknown quarantined copy cannot be retried, receipted or activated', () => {
  const f = prepared();
  f.store.claimCopy(context, f.intent.generationId);
  f.store.bindHelper(context, f.intent.generationId, receipt(f.intent).helperId);
  f.store.quarantine(context, f.intent.generationId);
  expect(f.store.claimCopy(context, f.intent.generationId)).toBe(false);
  expect(() => f.store.recordCopy(context, f.intent.generationId, receipt(f.intent))).toThrow(
    'dispatched intent',
  );
  expect(() => f.store.activate(context, f.intent.generationId)).toThrow('receipt');
});
it('rejects unbound, cross-generation and changed terminal proof', () => {
  const f = prepared();
  f.store.claimCopy(context, f.intent.generationId);
  expect(() => f.store.recordCopy(context, f.intent.generationId, receipt(f.intent))).toThrow();
  f.store.bindHelper(context, f.intent.generationId, receipt(f.intent).helperId);
  for (const field of [
    'helperId',
    'volumeName',
    'intentDigest',
    'exportReceiptDigest',
    'commit',
    'tree',
    'manifestDigest',
    'committedTreeDigest',
    'bundleSha256',
  ] as const) {
    const value = ['commit', 'tree'].includes(field)
      ? 'c'.repeat(40)
      : field.endsWith('Digest') || field === 'bundleSha256'
        ? 'c'.repeat(64)
        : 'other';
    expect(() =>
      f.store.recordCopy(context, f.intent.generationId, { ...receipt(f.intent), [field]: value }),
    ).toThrow();
  }
  expect(f.store.historical(context, f.intent.generationId).state).toBe('copy_uncertain');
});
it('fresh authority/parent/copy proof gates cannot be bypassed', () => {
  const f = copied();
  f.proof.authority.mockImplementation(() => {
    throw new Error('revoked');
  });
  expect(() => f.store.activate(context, f.intent.generationId)).toThrow('revoked');
  f.proof.authority.mockReturnValue(true);
  f.proof.parent.mockImplementation(() => {
    throw new Error('parent changed');
  });
  expect(() => f.store.activate(context, f.intent.generationId)).toThrow('parent changed');
  f.proof.parent.mockReturnValue(true);
  f.proof.copy.mockReturnValue(undefined as never);
  expect(() => f.store.activate(context, f.intent.generationId)).toThrow('synchronous');
  expect(f.store.active(context).generationId).toBe('initial');
});
it('retains scoped historical lookup and rejects foreign custody', () => {
  const f = copied();
  expect(() =>
    f.store.historical({ ...context, custodyDigest: 'c'.repeat(64) }, f.intent.generationId),
  ).toThrow('custody');
  expect(() => f.store.active({ ...context, workspace: 'other' })).toThrow('custody');
});
it('two independent SQLite connections cannot both claim the copy', () => {
  const f = prepared();
  const other = f.open().store;
  expect(f.store.claimCopy(context, f.intent.generationId)).toBe(true);
  expect(other.claimCopy(context, f.intent.generationId)).toBe(false);
});
it('two real processes compete for one active pointer, retaining losing verified child', async () => {
  const f = copied();
  const other = f.store.reserve({ ...request, operationId: 'second' });
  f.store.claimCopy(context, other.generationId);
  f.store.bindHelper(context, other.generationId, receipt(other).helperId);
  f.store.recordCopy(context, other.generationId, receipt(other));
  const moduleUrl = pathToFileURL(resolve('server/symposium-artifact-generations.ts')).href;
  const code = `import Database from 'better-sqlite3';import {SymposiumArtifactGenerations} from ${JSON.stringify(moduleUrl)};const db=new Database(process.argv[1]);const yes=()=>true;const s=new SymposiumArtifactGenerations(db,{initial:yes,authority:yes,parent:yes,copy:yes});try{s.activate(JSON.parse(process.argv[3]),process.argv[2]);process.stdout.write('activated');}catch(e){if(!String(e.message).includes('CAS conflict'))throw e;process.stdout.write('conflict');}finally{db.close();}`;
  const run = (generation: string) =>
    promisify(execFile)(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      code,
      f.path,
      generation,
      JSON.stringify(context),
    ]);
  const results = await Promise.all([run(f.intent.generationId), run(other.generationId)]);
  expect(results.map((r) => r.stdout).sort()).toEqual(['activated', 'conflict']);
  expect(f.store.active(context).revision).toBe(1);
  expect(f.store.historical(context, 'initial').initial).toEqual(initial);
}, 15000);
it('retains uncertain copy claim after abrupt process death before helper receipt', async () => {
  const f = prepared();
  const moduleUrl = pathToFileURL(resolve('server/symposium-artifact-generations.ts')).href;
  const code = `import Database from 'better-sqlite3';import {SymposiumArtifactGenerations} from ${JSON.stringify(moduleUrl)};const db=new Database(process.argv[1]);const yes=()=>true;const s=new SymposiumArtifactGenerations(db,{initial:yes,authority:yes,parent:yes,copy:yes});s.claimCopy(JSON.parse(process.argv[3]),process.argv[2]);process.kill(process.pid,'SIGKILL');`;
  await expect(
    promisify(execFile)(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      code,
      f.path,
      f.intent.generationId,
      JSON.stringify(context),
    ]),
  ).rejects.toMatchObject({ signal: 'SIGKILL' });
  const reopened = f.open().store;
  expect(reopened.historical(context, f.intent.generationId)).toMatchObject({
    state: 'copy_uncertain',
    receipt: null,
  });
  expect(reopened.claimCopy(context, f.intent.generationId)).toBe(false);
  expect(() => reopened.activate(context, f.intent.generationId)).toThrow('receipt');
}, 15000);
it('retains helper and terminal observation before later proof failure without activating', () => {
  const f = prepared();
  f.store.claimCopy(context, f.intent.generationId);
  f.proof.authority.mockImplementation(() => {
    throw new Error('revoked');
  });
  f.store.bindHelper(context, f.intent.generationId, receipt(f.intent).helperId);
  f.proof.copy.mockImplementation(() => {
    throw new Error('verification unavailable');
  });
  expect(() => f.store.recordCopy(context, f.intent.generationId, receipt(f.intent))).toThrow(
    'verification unavailable',
  );
  f.db.close();
  const reopened = f.open().store;
  expect(reopened.historical(context, f.intent.generationId)).toMatchObject({
    helperId: receipt(f.intent).helperId,
    terminalObservation: receipt(f.intent),
    receipt: null,
    state: 'copy_uncertain',
  });
  expect(() => reopened.activate(context, f.intent.generationId)).toThrow('revoked');
});
