import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CollaborationApplicationReviewResultSchema } from '@mitzo/protocol';
import { createCollaborationRetainedArtifactFixture } from './fixtures/collaboration-retained-artifacts.js';
import { createRetainedCollaborationArtifactSource } from '../collaboration-retained-artifact-source.js';
import {
  createJoiningRetainedArtifacts,
  joiningRetainedArtifactKey,
} from '../collaboration-joining-retained-artifacts.js';

let fixture: ReturnType<typeof createCollaborationRetainedArtifactFixture>;
beforeEach(() => {
  fixture = createCollaborationRetainedArtifactFixture();
});
afterEach(() => {
  fixture.close();
  vi.restoreAllMocks();
});

function setup() {
  const save = (content: string, sessionId: string) =>
    fixture.store.save({
      itemId: fixture.itemId,
      filename: 'plan.md',
      title: 'Reviewed plan',
      bytes: Buffer.from(content),
      sessionId,
      sourcePath: '/synthetic/plan.md',
    });
  save('first', 'current-conversation');
  const selected = save('  Exact r2\r\nπ  ', 'user-edit:origin-no-longer-present');
  save('r3 MUST NOT REPLACE r2', 'another-editor');
  const pin = {
    kind: 'retainedArtifactVersion' as const,
    artifactId: selected.id,
    revision: selected.revision,
    sha256: selected.sha256,
  };
  // A private host capability stands in for core's opened-prefix association.
  // It is not a production association algorithm or an application grant.
  const associated = new Set(
    fixture.store.sourceMaterialPage('current-conversation').artifacts.map((a) => a.id),
  );
  let sourceCurrent = true;
  let access = true;
  const association = {
    assertAssociated: vi.fn(async () => {
      if (!associated.has(pin.artifactId)) throw Error('unassociated');
    }),
    assertCurrent: vi.fn(() => {
      if (!sourceCurrent || !associated.has(pin.artifactId)) throw Error('source changed');
    }),
  };
  const authorization = {
    authorize: vi.fn(async () => {
      if (!access) throw Error('denied');
    }),
    assertCurrent: vi.fn(() => {
      if (!access) throw Error('revoked');
    }),
  };
  const source = createRetainedCollaborationArtifactSource({
    store: fixture.store,
    authorizeArtifact: authorization.authorize,
  });
  const bridge = () =>
    createJoiningRetainedArtifacts({ store: fixture.store, source, association, authorization });
  return {
    selected,
    pin,
    source,
    association,
    authorization,
    bridge,
    revoke: () => {
      access = false;
    },
    loseSource: () => {
      sourceCurrent = false;
    },
    unassociate: () => {
      associated.clear();
    },
  };
}

it('reads exact r2 with bytes, filename and original provenance while r3 exists, without origin transcript access', async () => {
  const f = setup();
  const read = await f.bridge().read(f.pin);
  expect(read.artifact).toEqual({
    ...f.pin,
    retention: 'independent',
    itemId: fixture.itemId,
    filename: 'plan.md',
    title: 'Reviewed plan',
    mediaType: 'application/octet-stream',
    provenance: {
      sessionId: 'user-edit:origin-no-longer-present',
      sourceKind: 'user_edit',
      sourcePath: '/synthetic/plan.md',
    },
    sizeBytes: Buffer.byteLength('  Exact r2\r\nπ  '),
    contentBase64: Buffer.from('  Exact r2\r\nπ  ').toString('base64'),
  });
  expect(read.artifact).not.toHaveProperty('sourceConversationId');
  expect(Object.isFrozen(read.artifact)).toBe(true);
  expect(Object.isFrozen(read.artifact.provenance)).toBe(true);
  expect(() => read.assertCurrent()).not.toThrow();
  expect(joiningRetainedArtifactKey(f.pin)).toContain('retainedArtifactVersion:');
  expect(JSON.parse(JSON.stringify(read.artifact))).toEqual(read.artifact);
});

it('reconstructs the same exact read after owner restart and a newer saved edit', async () => {
  const f = setup();
  const original = (await f.bridge().read(f.pin)).artifact;
  fixture.restart();
  const source = createRetainedCollaborationArtifactSource({
    store: fixture.store,
    authorizeArtifact: f.authorization.authorize,
  });
  const next = createJoiningRetainedArtifacts({
    store: fixture.store,
    source,
    association: f.association,
    authorization: f.authorization,
  });
  expect((await next.read(f.pin)).artifact).toEqual(original);
});

it('browses exact revision metadata with bounded keyset paging and no blob hydration', async () => {
  const f = setup();
  const bytes = vi.spyOn(fixture.store, 'readBoundedRevision');
  const sourceRead = vi.spyOn(f.source, 'read');
  const b = f.bridge();
  const page = await b.revisionPage(f.pin, { limit: 2 });
  expect(page.artifacts.map((a) => a.revision)).toEqual([3, 2]);
  expect(page).toMatchObject({ cursor: 2, hasMore: true });
  const older = await b.revisionPage(f.pin, { limit: 2, beforeRevision: page.cursor! });
  expect(older.artifacts.map((a) => a.revision)).toEqual([1]);
  expect(older).toMatchObject({ cursor: null, hasMore: false });
  expect(await b.metadata(f.pin)).toMatchObject({ ...f.pin, filename: 'plan.md' });
  expect(page.artifacts.every((a) => !('contentBase64' in a))).toBe(true);
  expect(bytes).not.toHaveBeenCalled();
  expect(sourceRead).not.toHaveBeenCalled();
});

it.each(['kind', 'hash', 'caller-authority', 'missing', 'unassociated'] as const)(
  'refuses %s before byte reads',
  async (fault) => {
    const f = setup();
    const input: Record<string, unknown> = { ...f.pin };
    if (fault === 'kind') input.kind = 'transcript_reference';
    if (fault === 'hash') input.sha256 = '0'.repeat(64);
    if (fault === 'caller-authority') input.itemId = fixture.itemId;
    if (fault === 'missing') input.artifactId = '0'.repeat(32);
    if (fault === 'unassociated') f.unassociate();
    const bytes = vi.spyOn(fixture.store, 'readBoundedRevision');
    await expect(f.bridge().read(input)).rejects.toThrow();
    expect(bytes).not.toHaveBeenCalled();
  },
);

it('does not let source-only association or underlying custody substitute for live artifact access', async () => {
  const f = setup();
  f.revoke();
  const bytes = vi.spyOn(fixture.store, 'readBoundedRevision');
  await expect(f.bridge().read(f.pin)).rejects.toThrow();
  await expect(f.bridge().metadata(f.pin)).rejects.toThrow();
  await expect(f.bridge().revisionPage(f.pin)).rejects.toThrow();
  expect(bytes).not.toHaveBeenCalled();
});

it.each(['source', 'association', 'access'] as const)(
  'renews %s at the synchronous save fence',
  async (fault) => {
    const f = setup();
    const result = await f.bridge().read(f.pin);
    if (fault === 'source') f.loseSource();
    if (fault === 'association') f.unassociate();
    if (fault === 'access') f.revoke();
    expect(() => result.assertCurrent()).toThrow();
  },
);

it('refuses source drift during asynchronous authorization before reading bytes', async () => {
  const f = setup();
  f.authorization.authorize.mockImplementationOnce(async () => {
    await Promise.resolve();
    f.loseSource();
  });
  const bytes = vi.spyOn(fixture.store, 'readBoundedRevision');
  await expect(f.bridge().read(f.pin)).rejects.toThrow();
  expect(bytes).not.toHaveBeenCalled();
});

it('refuses access revoked after the retained read and before its final authorization returns', async () => {
  const f = setup();
  const read = f.source.read.bind(f.source);
  vi.spyOn(f.source, 'read').mockImplementation(async (pin) => {
    const result = await read(pin);
    f.revoke();
    return result;
  });
  await expect(f.bridge().read(f.pin)).rejects.toThrow();
});

it.each(['association', 'authority', 'custody'] as const)(
  'rejects accidental Promise-returning %s final fences',
  async (fault) => {
    const f = setup();
    const result = await f.bridge().read(f.pin);
    if (fault === 'association') f.association.assertCurrent.mockImplementation(async () => {});
    if (fault === 'authority')
      f.authorization.assertCurrent.mockImplementation(async () => {
        throw Error('not a sync authority');
      });
    if (fault === 'custody') {
      const read = f.source.read.bind(f.source);
      vi.spyOn(f.source, 'read').mockImplementation(async (pin) => ({
        ...(await read(pin)),
        assertCurrent: async () => {},
      }));
      await expect(f.bridge().read(f.pin)).rejects.toThrow();
      return;
    }
    expect(() => result.assertCurrent()).toThrow();
    await Promise.resolve();
  },
);

it.each(['association', 'authority', 'custody'] as const)(
  'refuses a nonvoid false result from the %s fence',
  async (fault) => {
    const f = setup();
    if (fault === 'association') f.association.assertCurrent.mockImplementation(() => false);
    if (fault === 'authority') f.authorization.assertCurrent.mockImplementation(() => false);
    if (fault === 'custody') {
      const read = f.source.read.bind(f.source);
      vi.spyOn(f.source, 'read').mockImplementation(async (pin) => ({
        ...(await read(pin)),
        assertCurrent: () => false,
      }));
    }
    await expect(f.bridge().read(f.pin)).rejects.toMatchObject({ code: 'snapshot_changed' });
  },
);

it('keeps private pinned metadata out of mutable capability arguments and caller input', async () => {
  const f = setup();
  const original = structuredClone(f.pin);
  f.authorization.authorize.mockImplementation(async (...args: unknown[]) => {
    const [pin, metadata] = args as [Record<string, unknown>, Record<string, unknown>];
    pin.revision = 3;
    metadata.sourcePath = '/changed';
  });
  const result = await f.bridge().read(f.pin);
  f.pin.revision = 3;
  expect(result.artifact).toMatchObject({
    ...original,
    provenance: { sourcePath: '/synthetic/plan.md' },
  });
  expect(() => result.assertCurrent()).not.toThrow();
});

it('refuses changed exact metadata or bytes at the final save fence', async () => {
  const f = setup();
  const result = await f.bridge().read(f.pin);
  const fault = new Database(fixture.path);
  try {
    fault
      .prepare('UPDATE telos_artifact_revisions SET bytes=? WHERE id=? AND revision=?')
      .run(Buffer.from('corrupt'), f.pin.artifactId, f.pin.revision);
  } finally {
    fault.close();
  }
  expect(() => result.assertCurrent()).toThrow();
});

it('refuses equal-length bytes changed by the late synchronous authority callback', async () => {
  const f = setup();
  const result = await f.bridge().read(f.pin);
  const replacement = Buffer.alloc(f.selected.size, 33);
  let callbacks = 0;
  f.authorization.assertCurrent.mockImplementation(() => {
    // The second authority callback runs after the underlying custody callback.
    if (++callbacks !== 2) return;
    const fault = new Database(fixture.path);
    try {
      fault
        .prepare('UPDATE telos_artifact_revisions SET bytes=? WHERE id=? AND revision=?')
        .run(replacement, f.pin.artifactId, f.pin.revision);
    } finally {
      fault.close();
    }
  });
  expect(() => result.assertCurrent()).toThrow();
  expect(callbacks).toBe(2);
  expect(fixture.store.metadataForRevision(f.pin.artifactId, f.pin.revision)).toMatchObject({
    size: replacement.length,
    sha256: f.pin.sha256,
  });
});

it('refuses earlier page metadata changed by the late synchronous last-entry callback', async () => {
  const f = setup();
  const bytes = vi.spyOn(fixture.store, 'readBoundedRevision');
  let lastEntryCallbacks = 0;
  f.authorization.assertCurrent.mockImplementation((...args: unknown[]) => {
    const metadata = args[1] as { revision: number };
    // First: revision1's observation. Second: the final whole-page callback pass,
    // after revision3 has already had its authority and metadata checked.
    if (metadata.revision !== 1 || ++lastEntryCallbacks !== 2) return;
    const fault = new Database(fixture.path);
    try {
      fault
        .prepare('UPDATE telos_artifact_revisions SET source_path=? WHERE id=? AND revision=3')
        .run('/changed-by-last-synchronous-callback', f.pin.artifactId);
    } finally {
      fault.close();
    }
  });
  await expect(f.bridge().revisionPage(f.pin)).rejects.toMatchObject({ code: 'snapshot_changed' });
  expect(lastEntryCallbacks).toBe(2);
  expect(bytes).not.toHaveBeenCalled();
});

it('refuses metadata drift in the last asynchronous artifact authorization', async () => {
  const f = setup();
  const read = f.source.read.bind(f.source);
  let bytesRead = false;
  vi.spyOn(f.source, 'read').mockImplementation(async (pin) => {
    const result = await read(pin);
    bytesRead = true;
    return result;
  });
  f.authorization.authorize.mockImplementation(async () => {
    await Promise.resolve();
    if (!bytesRead) return;
    const fault = new Database(fixture.path);
    try {
      fault
        .prepare('UPDATE telos_artifact_revisions SET source_path=? WHERE id=? AND revision=?')
        .run('/changed-during-final-await', f.pin.artifactId, f.pin.revision);
    } finally {
      fault.close();
    }
  });
  await expect(f.bridge().read(f.pin)).rejects.toMatchObject({ code: 'snapshot_changed' });
});

it('checks all earlier catalog observations after the last page authorization await', async () => {
  const f = setup();
  f.authorization.authorize.mockImplementation(async (...args: unknown[]) => {
    const metadata = args[1] as { revision: number };
    await Promise.resolve();
    if (metadata.revision !== 1) return;
    const fault = new Database(fixture.path);
    try {
      fault
        .prepare('UPDATE telos_artifact_revisions SET source_path=? WHERE id=? AND revision=3')
        .run('/changed-earlier-page-entry', f.pin.artifactId);
    } finally {
      fault.close();
    }
  });
  await expect(f.bridge().revisionPage(f.pin)).rejects.toMatchObject({ code: 'snapshot_changed' });
});

it('independently verifies bytes supplied by the retained port before projecting them', async () => {
  const f = setup();
  const read = f.source.read.bind(f.source);
  vi.spyOn(f.source, 'read').mockImplementation(async (pin) => {
    const result = await read(pin);
    return { ...result, bytes: Buffer.alloc(result.bytes.byteLength, 33) };
  });
  await expect(f.bridge().read(f.pin)).rejects.toMatchObject({ code: 'snapshot_changed' });
});

it('bounds the entire metadata page before disclosure, without blob hydration', async () => {
  const f = setup();
  const fault = new Database(fixture.path);
  try {
    fault
      .prepare('UPDATE telos_artifact_revisions SET source_path=? WHERE id=?')
      .run('p'.repeat(200 * 1024), f.pin.artifactId);
  } finally {
    fault.close();
  }
  const bytes = vi.spyOn(fixture.store, 'readBoundedRevision');
  await expect(f.bridge().revisionPage(f.pin)).rejects.toMatchObject({ code: 'capacity_refused' });
  expect(bytes).not.toHaveBeenCalled();
});

it('refuses privacy reclassification and source-capture material', async () => {
  const f = setup();
  const result = await f.bridge().read(f.pin);
  const db = new Database(fixture.path);
  try {
    db.prepare('UPDATE items SET profile=? WHERE id=?').run('lifeops', fixture.itemId);
  } finally {
    db.close();
  }
  expect(() => result.assertCurrent()).toThrow();
  await expect(f.bridge().read(f.pin)).rejects.toThrow();
});

it('does not expose source-capture metadata or bytes through the catalog', async () => {
  const f = setup();
  const capture = fixture.store.save({
    itemId: fixture.itemId,
    filename: 'capture.json',
    title: 'Private capture',
    bytes: Buffer.from('{}'),
    sessionId: 'source-capture:fixture',
  });
  const pin = {
    ...f.pin,
    artifactId: capture.id,
    revision: capture.revision,
    sha256: capture.sha256,
  };
  f.association.assertAssociated.mockResolvedValue();
  const b = f.bridge();
  await expect(b.read(pin)).rejects.toThrow();
  await expect(b.metadata(pin)).rejects.toThrow();
});

it('refuses oversized byte/serialized metadata budgets and unbounded paging', async () => {
  const f = setup();
  const huge = fixture.store.save({
    itemId: fixture.itemId,
    filename: 'huge.txt',
    title: 'Huge',
    bytes: Buffer.alloc(512 * 1024 + 1),
    sessionId: 'current-conversation',
  });
  const pin = { ...f.pin, artifactId: huge.id, revision: huge.revision, sha256: huge.sha256 };
  f.association.assertAssociated.mockResolvedValue();
  f.association.assertCurrent.mockImplementation(() => {});
  const bytes = vi.spyOn(fixture.store, 'readBoundedRevision');
  await expect(f.bridge().read(pin)).rejects.toThrow();
  expect(bytes).not.toHaveBeenCalled();
  await expect(f.bridge().revisionPage(f.pin, { limit: 51 })).rejects.toThrow();
  const large = fixture.store.save({
    itemId: fixture.itemId,
    filename: 'large.txt',
    title: 'Large',
    bytes: Buffer.alloc(400 * 1024),
    sessionId: 'current-conversation',
  });
  await expect(
    f
      .bridge()
      .read({ ...pin, artifactId: large.id, revision: large.revision, sha256: large.sha256 }),
  ).rejects.toMatchObject({ code: 'capacity_refused' });
  const original = fixture.store.metadataForRevision.bind(fixture.store);
  vi.spyOn(fixture.store, 'metadataForRevision').mockImplementation((id, revision) => ({
    ...original(id, revision),
    sourcePath: 'p'.repeat(512 * 1024),
  }));
  await expect(f.bridge().metadata(f.pin)).rejects.toMatchObject({ code: 'capacity_refused' });
});

it('preserves exact labels from the actual retained owner across the shared response schema', () => {
  const saved = fixture.store.save({
    itemId: fixture.itemId,
    filename: ' plan.md',
    title: ' Plan ',
    bytes: Buffer.from('exact'),
    sessionId: 'current-conversation',
  });
  const label = {
    kind: 'retainedArtifactVersion' as const,
    artifactId: saved.id,
    revision: saved.revision,
    sha256: saved.sha256,
    title: saved.title,
    filename: saved.filename,
  };
  expect(saved.filename).toBe(' plan.md');
  expect(saved.title).toBe(' Plan ');
  expect(
    CollaborationApplicationReviewResultSchema.shape.artifactLabels.unwrap().parse([label]),
  ).toEqual([label]);
});
