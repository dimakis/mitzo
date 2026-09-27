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
import { ArtifactAdmissionBindingV1Schema } from '@mitzo/protocol';
import {
  assertSuccessorFixAuthority,
  type SuccessorFixAuthority,
} from '../symposium-artifact-successor-authority.js';
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
    'quarantined',
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
    'revoked',
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
it('retains late helper identity after quarantine without allowing activation or copy proof', () => {
  const f = prepared();
  f.store.claimCopy(context, f.intent.generationId);
  f.store.quarantine(context, f.intent.generationId);
  f.store.bindHelper(context, f.intent.generationId, receipt(f.intent).helperId);
  expect(f.store.historical(context, f.intent.generationId)).toMatchObject({
    state: 'quarantined',
    helperId: receipt(f.intent).helperId,
  });
  expect(() => f.store.recordCopy(context, f.intent.generationId, receipt(f.intent))).toThrow();
  expect(() => f.store.activate(context, f.intent.generationId)).toThrow();
});
it('retains late terminal evidence after quarantine across reopen without verification', () => {
  const f = prepared();
  f.store.claimCopy(context, f.intent.generationId);
  f.store.quarantine(context, f.intent.generationId);
  const terminal = receipt(f.intent);
  f.store.bindHelper(context, f.intent.generationId, terminal.helperId);
  expect(() => f.store.recordCopy(context, f.intent.generationId, terminal)).toThrow();
  const reopened = f.open();
  expect(
    reopened.db
      .prepare(
        'SELECT receipt_json FROM symposium_artifact_copy_observations WHERE generation_id=?',
      )
      .get(f.intent.generationId),
  ).toEqual({ receipt_json: canonicalReviewJson(terminal) });
  expect(reopened.store.historical(context, f.intent.generationId).state).toBe('quarantined');
  expect(f.proof.copy).not.toHaveBeenCalled();
  expect(() => reopened.store.activate(context, f.intent.generationId)).toThrow();
  expect(() =>
    reopened.store.recordCopy(context, f.intent.generationId, {
      ...terminal,
      verificationDigest: 'c'.repeat(64),
    }),
  ).toThrow(/observation conflict/);
});
it('retains terminal observation but cannot verify after authority is revoked', () => {
  const f = prepared();
  f.store.claimCopy(context, f.intent.generationId);
  const terminal = receipt(f.intent);
  f.store.bindHelper(context, f.intent.generationId, terminal.helperId);
  f.proof.authority.mockImplementation(() => {
    throw new Error('authority revoked');
  });
  expect(() => f.store.recordCopy(context, f.intent.generationId, terminal)).toThrow(
    /authority revoked/,
  );
  const reopened = f.open();
  expect(
    reopened.db
      .prepare(
        'SELECT receipt_json FROM symposium_artifact_copy_observations WHERE generation_id=?',
      )
      .get(f.intent.generationId),
  ).toEqual({ receipt_json: canonicalReviewJson(terminal) });
  expect(reopened.store.historical(context, f.intent.generationId).state).toBe('copy_uncertain');
  expect(f.proof.copy).not.toHaveBeenCalled();
  expect(() => reopened.store.activate(context, f.intent.generationId)).toThrow(
    /authority revoked/,
  );
});
it.each([
  'exportReceiptDigest',
  'commit',
  'tree',
  'manifestDigest',
  'committedTreeDigest',
  'bundleSha256',
] as const)('retains failed %s lineage evidence across reopen without promoting it', (field) => {
  const f = prepared();
  f.store.claimCopy(context, f.intent.generationId);
  const terminal = {
    ...receipt(f.intent),
    [field]: 'c'.repeat(field === 'commit' || field === 'tree' ? 40 : 64),
  };
  f.store.bindHelper(context, f.intent.generationId, terminal.helperId);
  expect(() => f.store.recordCopy(context, f.intent.generationId, terminal)).toThrow();
  f.db.close();
  const reopened = f.open().store;
  expect(reopened.historical(context, f.intent.generationId)).toMatchObject({
    state: 'copy_uncertain',
    terminalObservation: terminal,
    receipt: null,
  });
  expect(f.proof.copy).not.toHaveBeenCalled();
  expect(() => reopened.activate(context, f.intent.generationId)).toThrow('receipt');
  expect(() => reopened.recordCopy(context, f.intent.generationId, terminal)).toThrow('lineage');
  expect(() => reopened.recordCopy(context, f.intent.generationId, receipt(f.intent))).toThrow(
    'observation conflict',
  );
});
it('scopes operation replay to session and migrates legacy keys without changing intent', () => {
  const f = prepared();
  f.db
    .prepare('UPDATE symposium_artifact_generations SET operation_id=? WHERE generation_id=?')
    .run(request.operationId, f.intent.generationId);
  const reopened = f.open().store;
  expect(reopened.reserve(request)).toEqual(f.intent);
  const second = {
    ...initial,
    sessionId: 'second',
    generationId: 'second-initial',
    volumeName: 'second-volume',
  };
  reopened.registerInitial(second);
  const child = reopened.reserve({
    ...request,
    sessionId: 'second',
    parentGenerationId: 'second-initial',
  });
  expect(child.request.operationId).toBe(request.operationId);
  expect(child.generationId).not.toBe(f.intent.generationId);
});
it('reports settled quarantine transition failure across independent connections', () => {
  const f = copied();
  const other = f.open().store;
  expect(() => other.quarantine(context, f.intent.generationId)).toThrow('settled');
  expect(other.historical(context, f.intent.generationId).state).toBe('verified');
});
it('racing quarantine and terminal verification never reports quarantine success for verified child', async () => {
  const f = prepared();
  f.store.claimCopy(context, f.intent.generationId);
  f.store.bindHelper(context, f.intent.generationId, receipt(f.intent).helperId);
  const moduleUrl = pathToFileURL(resolve('server/symposium-artifact-generations.ts')).href;
  const code = `import Database from 'better-sqlite3';import {SymposiumArtifactGenerations} from ${JSON.stringify(moduleUrl)};const db=new Database(process.argv[1]);const yes=()=>true;const s=new SymposiumArtifactGenerations(db,{initial:yes,authority:yes,parent:yes,copy:yes});try{if(process.argv[2]==='quarantine')s.quarantine(JSON.parse(process.argv[4]),process.argv[3]);else s.recordCopy(JSON.parse(process.argv[4]),process.argv[3],JSON.parse(process.argv[5]));process.stdout.write('ok');}catch(e){process.stdout.write('rejected');}finally{db.close();}`;
  const run = (mode: string) =>
    promisify(execFile)(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      code,
      f.path,
      mode,
      f.intent.generationId,
      JSON.stringify(context),
      JSON.stringify(receipt(f.intent)),
    ]);
  const [quarantine] = await Promise.all([run('quarantine'), run('copy')]);
  expect(f.store.historical(context, f.intent.generationId).state).toBe(
    quarantine.stdout === 'ok' ? 'quarantined' : 'verified',
  );
}, 15000);

it('retains ordered physical effects across reopen without granting retry or activation', () => {
  const f = fixture();
  const { store, db } = f.open();
  store.registerInitial(initial);
  const intent = store.reserve(request);
  expect(store.claimCopy(context, intent.generationId)).toBe(true);
  store.observePhysical(context, intent.generationId, { phase: 'volume_create_dispatched' });
  store.observePhysical(context, intent.generationId, {
    phase: 'volume_created',
    name: intent.volumeName,
  });
  store.observePhysical(context, intent.generationId, { phase: 'helper_create_dispatched' });
  const helperId = 'c'.repeat(64);
  store.observePhysical(context, intent.generationId, { phase: 'helper_created', helperId });
  db.close();
  const reopened = f.open().store;
  expect(reopened.historical(context, intent.generationId)).toMatchObject({
    state: 'copy_uncertain',
    helperId,
    physical: [
      { phase: 'volume_create_dispatched' },
      { phase: 'volume_created', name: intent.volumeName },
      { phase: 'helper_create_dispatched' },
      { phase: 'helper_created', helperId },
    ],
  });
  expect(reopened.claimCopy(context, intent.generationId)).toBe(false);
  expect(() =>
    reopened.observePhysical(context, intent.generationId, { phase: 'helper_removed', helperId }),
  ).toThrow();
  reopened.observePhysical(context, intent.generationId, {
    phase: 'terminal',
    helperId,
    exitCode: 23,
    proofDigest: null,
  });
  reopened.observePhysical(context, intent.generationId, { phase: 'helper_removed', helperId });
  reopened.quarantine(context, intent.generationId);
  reopened.observePhysical(context, intent.generationId, { phase: 'helper_absent', helperId });
  expect(() => reopened.activate(context, intent.generationId)).toThrow();
  expect(() =>
    reopened.observePhysical(context, intent.generationId, {
      phase: 'terminal',
      helperId,
      exitCode: 0,
      proofDigest: hash,
    }),
  ).toThrow();
});
it('retains an exact admission receipt with pointer CAS and rejects unconfirmed identity substitution', () => {
  const f = copied();
  const binding = {
    version: 1 as const,
    transitionId: 'transition',
    operationId: request.operationId,
    sessionId: request.sessionId,
    workspaceId: request.workspace,
    custodyDigest: request.custodyDigest,
    parentGenerationId: request.parentGenerationId,
    parentFenceId: 'fence',
    parentSealDigest: request.parentSealDigest,
    childGenerationId: f.intent.generationId,
    childVolumeName: f.intent.volumeName,
    copyReceiptDigest: reviewRecordHash(canonicalReviewJson(receipt(f.intent))),
    expectedPointerRevision: 0,
    activatedPointerRevision: 1,
    workflowId: request.workflowId,
    fixAttemptId: request.fixAttemptId,
    policyReservationId: 'reservation',
    seatId: request.seatId,
    actor: request.actor,
    expectedConfigRevision: 1,
    resultingConfigRevision: 2,
    predecessorMembershipGeneration: 1,
    successorMembershipGeneration: 2,
    accountBinding: {
      accountId: 'personal',
      accountLabel: 'Personal',
      provider: 'openai-codex' as const,
      model: 'luna-fixture',
      profileRevision: '1',
    },
    profileBinding: { profileId: request.profileId, profileRevision: request.profileRevision },
    contextGrant: { grantId: 'context', revision: 1 },
    authorityGrant: { grantId: request.authorityGrantId, revision: 1 },
    findingFingerprints: request.findingFingerprints,
  };
  expect(() =>
    f.store.activateAdmission(binding, () => {
      throw Error('intent absent');
    }),
  ).toThrow('intent absent');
  expect(f.store.active(context).generationId).toBe('initial');
  const activation = f.store.activateAdmission(binding, () => true);
  expect(f.open().store.requireAdmission(binding)).toEqual(activation);
  expect(f.store.activateAdmission(binding, () => true)).toEqual(activation);
  expect(() => f.store.requireAdmission({ ...binding, policyReservationId: 'other' })).toThrow();
});
it('admits an imported parent only for the exact initial attempt and selected authority', () => {
  const f = fixture();
  f.store.registerInitial(initial);
  const { fixAttemptId: _fixAttemptId, findingFingerprints: _findings, ...common } = request;
  void _fixAttemptId;
  void _findings;
  const accountBinding = {
    accountId: 'personal',
    accountLabel: 'Personal',
    provider: 'openai-codex' as const,
    model: 'luna-fixture',
    profileRevision: '1',
  };
  const initialRequest: ArtifactGenerationRequest = {
    ...common,
    kind: 'initial',
    sourceSealId: 'source-seal',
    initialAttemptId: 'first-attempt',
    policyReservationId: 'initial-reservation',
    expectedConfigRevision: 1,
    predecessorMembershipGeneration: 1,
    accountBinding,
    contextGrant: { grantId: 'context', revision: 1 },
  };
  const intent = f.store.reserve(initialRequest);
  f.store.claimCopy(context, intent.generationId);
  f.store.bindHelper(context, intent.generationId, receipt(intent).helperId);
  f.store.recordCopy(context, intent.generationId, receipt(intent));
  const binding = ArtifactAdmissionBindingV1Schema.parse({
    version: 1,
    kind: 'initial',
    transitionId: 'initial-transition',
    operationId: initialRequest.operationId,
    sessionId: initialRequest.sessionId,
    workspaceId: initialRequest.workspace,
    custodyDigest: initialRequest.custodyDigest,
    parentGenerationId: initialRequest.parentGenerationId,
    parentSealDigest: initialRequest.parentSealDigest,
    sourceSealId: initialRequest.sourceSealId,
    childGenerationId: intent.generationId,
    childVolumeName: intent.volumeName,
    copyReceiptDigest: reviewRecordHash(canonicalReviewJson(receipt(intent))),
    expectedPointerRevision: 0,
    activatedPointerRevision: 1,
    workflowId: initialRequest.workflowId,
    initialAttemptId: initialRequest.initialAttemptId,
    policyReservationId: initialRequest.policyReservationId,
    seatId: initialRequest.seatId,
    actor: initialRequest.actor,
    expectedConfigRevision: 1,
    resultingConfigRevision: 2,
    predecessorMembershipGeneration: 1,
    successorMembershipGeneration: 2,
    accountBinding,
    profileBinding: { profileId: 'profile', profileRevision: '1' },
    contextGrant: initialRequest.contextGrant,
    authorityGrant: { grantId: initialRequest.authorityGrantId, revision: 1 },
  });
  expect(() =>
    ArtifactAdmissionBindingV1Schema.parse({ ...binding, findingFingerprints: [hash] }),
  ).toThrow();
  expect(() =>
    f.store.activateAdmission({ ...binding, initialAttemptId: 'wrong' }, () => true),
  ).toThrow('mismatch');
  expect(() =>
    f.store.activateAdmission({ ...binding, policyReservationId: 'wrong' }, () => true),
  ).toThrow('mismatch');
  expect(() =>
    f.store.activateAdmission(
      { ...binding, accountBinding: { ...accountBinding, model: 'other' } },
      () => true,
    ),
  ).toThrow('mismatch');
  const activation = f.store.activateAdmission(binding, () => true);
  expect(f.store.requireAdmission(binding)).toEqual(activation);
  expect(f.store.historical(context, 'initial').initial).toEqual(initial);
});
it('requires a retained initial policy reservation rather than fabricated fix findings', () => {
  const { fixAttemptId: _fixAttemptId, findingFingerprints: _findings, ...common } = request;
  void _fixAttemptId;
  void _findings;
  const initialRequest: ArtifactGenerationRequest = {
    ...common,
    kind: 'initial',
    sourceSealId: 'source-seal',
    initialAttemptId: 'first-attempt',
    policyReservationId: 'reservation',
    expectedConfigRevision: 1,
    predecessorMembershipGeneration: 1,
    accountBinding: {
      accountId: 'personal',
      accountLabel: 'Personal',
      provider: 'openai-codex',
      model: 'luna-fixture',
      profileRevision: '1',
    },
    contextGrant: { grantId: 'context', revision: 1 },
  };
  const state = {
    limits: { mode: 'application' },
    status: 'awaiting_initial',
    implementation: null,
    sessionId: 'session',
    owner: 'owner',
    initialArtifact: { revision: oid, hash },
    implementer: {
      seatId: 'writer',
      accountId: 'personal',
      model: 'luna-fixture',
      profileId: 'profile',
      profileRevision: 1,
    },
    applicationAttempts: [],
    applicationPreparations: [
      {
        kind: 'initial',
        status: 'preparing',
        workflowId: 'workflow',
        attemptId: 'first-attempt',
        policyReservationId: 'reservation',
        sourceSealId: 'source-seal',
        actorSeatId: 'writer',
        artifactRevision: oid,
        artifactHash: hash,
        transitionId: 'transition',
        seal: {
          fenceId: 'source-seal',
          artifactGenerationId: 'initial',
          volumeName: 'source-volume',
          sealDigest: hash,
          artifactRevision: oid,
          artifactHash: hash,
        },
        from: { configRevision: 1, membershipGeneration: 1 },
        to: { configRevision: 2, membershipGeneration: 2 },
        expectedSelection: {
          accountId: 'personal',
          model: 'luna-fixture',
          profileId: 'profile',
          profileRevision: '1',
          accountProfileRevision: '1',
        },
      },
    ],
  };
  const authority = {
    workflows: { get: () => state },
    assertCurrent: () => true as const,
  } as unknown as SuccessorFixAuthority;
  expect(assertSuccessorFixAuthority(authority, initialRequest)).toBe(true);
  expect(() =>
    assertSuccessorFixAuthority(authority, { ...initialRequest, policyReservationId: 'other' }),
  ).toThrow('initial attempt');
  expect(() =>
    assertSuccessorFixAuthority(authority, { ...initialRequest, expectedConfigRevision: 2 }),
  ).toThrow('initial attempt');
  state.applicationPreparations[0].status = 'bound';
  expect(() => assertSuccessorFixAuthority(authority, initialRequest)).toThrow('initial attempt');
});
