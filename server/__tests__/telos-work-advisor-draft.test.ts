import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { createTelosSourceApprovalData } from './fixtures/telos-source-approval-data.js';
import { TelosWorkAdvisorDraft } from '../telos-work-advisor-draft.js';
import { retainTelosWorkRoleContext } from '../telos-work-role-context.js';
import { reviewTelosWorkRoleContext } from '../telos-work-role-review.js';
import { TelosSourceCapture } from '../telos-source-capture.js';
import { TelosArtifactStore } from '../telos-artifact-store.js';
import type { TelosWorkAdvisorDraftPreviewRequest } from '@mitzo/protocol';
import { createTelosWorkRoleHost } from '../telos-work-role-host.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close());
});
function fixture(purpose: 'child' | 'refine' = 'child') {
  const f = createTelosSourceApprovalData();
  cleanups.push(() => f.close());
  const db = new Database(f.dbPath);
  db.exec("ALTER TABLE items ADD COLUMN categories TEXT DEFAULT '[]'");
  db.close();
  const binding = {
    accountId: 'offline',
    accountLabel: 'Offline',
    provider: 'openai-codex' as const,
    profileRevision: 'r1',
    model: 'offline-fixture',
  };
  f.events.upsertSession({ sessionId: 'planning', accountBinding: binding });
  f.work.execute(
    {
      operation: 'classify',
      itemId: 'studio',
      requestId: 'parent-kind',
      expectedRevision: f.work.read('studio', f.actor).revision,
      kind: 'outcome',
    },
    f.actor,
  );
  const context = reviewTelosWorkRoleContext({
    work: f.work,
    artifacts: f.artifacts,
    actor: f.actor,
    itemId: 'studio',
    role: 'advisor',
    advisorPurpose: purpose,
    selectedSourceSnapshotIds: [],
    selectedArtifactRefs: [],
  });
  retainTelosWorkRoleContext(f.events, 'planning', binding, context);
  f.work.execute(
    {
      operation: 'link',
      itemId: 'studio',
      requestId: 'bound-advisor',
      expectedRevision: f.work.read('studio', f.actor).revision,
      role: 'advisor',
      conversation: { namespace: 'mitzo', conversationId: 'planning' },
    },
    f.actor,
  );
  const sequence = f.events.append('planning', 'user_message', {
    messageId: 'draft-choice',
    text: 'Save this acoustic treatment draft; implementation remains a separate decision.',
  });
  const assertAuthorized = vi.fn(() => {});
  const authorizeArtifact = vi.fn((_actor: unknown, _itemId: string) => true);
  const deps = () => ({
    events: f.events,
    artifacts: f.artifacts,
    work: f.work,
    assertAuthorized,
    authorizeSource: () => true,
    authorizeArtifact,
  });
  const revision = f.work.read('studio', f.actor).revision;
  const input: TelosWorkAdvisorDraftPreviewRequest = {
    requestId: randomUUID(),
    operation: purpose,
    itemId: 'studio',
    advisorConversationId: 'planning',
    expectedRevision: revision,
    parentId: purpose === 'child' ? 'studio' : null,
    expectedParentRevision: purpose === 'child' ? revision : null,
    proposed: {
      name: 'Acoustic treatment',
      desiredOutcome: 'Record with the reviewed acoustic treatment',
      type: purpose === 'refine' ? 'outcome' : 'work_item',
      category: 'Music',
    },
    selection: {
      requestId: randomUUID(),
      expectedMembershipRevision: 0,
      sourceConversationId: 'planning',
      mode: 'selected' as const,
      boundary: { sequence, messageId: 'draft-choice' },
      messageIds: ['draft-choice'],
      artifacts: [],
      purpose: 'Save the reviewed planning draft',
      joiningBrief: '',
    },
  };
  return {
    f,
    input,
    assertAuthorized,
    authorizeArtifact,
    owner: () => new TelosWorkAdvisorDraft(deps()),
    capture: () => new TelosSourceCapture(deps()),
  };
}

it.each(['privacy', 'permission', 'bytes'] as const)(
  'refuses unrelated material %s revocation after compilation without retaining any advisor save mutation',
  async (revocation) => {
    const r = fixture();
    const db = new Database(r.f.dbPath);
    db.prepare(
      "INSERT INTO items(id,parent_id,summary,intent,rationale,acceptance_criteria,profile,status,starred,context_hints,created_at,updated_at,categories) SELECT 'material-owner',NULL,summary,intent,rationale,acceptance_criteria,profile,status,starred,context_hints,created_at,updated_at,categories FROM items WHERE id='studio'",
    ).run();
    const material = r.f.artifacts.save({
      itemId: 'material-owner',
      filename: 'reviewed.txt',
      title: 'Explicit unrelated public material',
      bytes: Buffer.from('Exact reviewed material'),
      sessionId: 'planning',
    });
    r.input.selection.artifacts = [
      { artifactId: material.id, revision: material.revision, sha256: material.sha256 },
    ];
    const preview = await r.owner().preview(r.input, r.f.actor);
    expect(preview.packet.context.artifacts).toContainEqual(
      expect.objectContaining(r.input.selection.artifacts[0]),
    );
    const input = { ...r.input, previewSha256: preview.sha256 };
    const parent = r.f.work.read('studio', r.f.actor);
    const counts = () =>
      [
        'items',
        'telos_artifact_revisions',
        'telos_artifact_save_requests',
        'telos_work_links',
        'telos_work_sources',
        'telos_work_commands',
      ].map((table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get());
    const before = counts();
    const revoke = () => {
      if (revocation === 'privacy')
        db.prepare("UPDATE items SET profile='lifeops' WHERE id='material-owner'").run();
      else if (revocation === 'permission')
        r.authorizeArtifact.mockImplementation((_actor, itemId) => itemId !== 'material-owner');
      else
        db.prepare('UPDATE telos_artifact_revisions SET bytes=? WHERE id=? AND revision=?').run(
          Buffer.from('Changed material bytes'),
          material.id,
          material.revision,
        );
    };
    const restore = () => {
      db.prepare("UPDATE items SET profile='personal' WHERE id='material-owner'").run();
      r.authorizeArtifact.mockImplementation(() => true);
      db.prepare('UPDATE telos_artifact_revisions SET bytes=? WHERE id=? AND revision=?').run(
        Buffer.from('Exact reviewed material'),
        material.id,
        material.revision,
      );
    };
    const compile = TelosSourceCapture.prototype.previewAdvisorDraft;
    vi.spyOn(TelosSourceCapture.prototype, 'previewAdvisorDraft').mockImplementationOnce(
      async function (this: TelosSourceCapture, raw, actor) {
        const actual = await compile.call(this, raw, actor);
        revoke();
        return actual;
      },
    );
    try {
      await expect(r.owner().save(input, r.f.actor)).rejects.toThrow();
      expect(counts()).toEqual(before);
      expect(r.f.work.read('studio', r.f.actor)).toEqual(parent);
      expect(r.f.work.advisorDraftReceipt(input, r.f.actor)).toBeUndefined();
      restore();
      const receipt = await r.owner().save(input, r.f.actor);
      expect(receipt.work.sources).toHaveLength(1);
      revoke();
      await expect(r.owner().save(input, r.f.actor)).rejects.toThrow();
      restore();
      expect(await r.owner().save(input, r.f.actor)).toEqual(receipt);
      expect(r.f.events.getOrdinaryInitialCommandId('planning')).toBeUndefined();
    } finally {
      db.close();
    }
  },
);
it('refuses to return compiled preview bytes after an unrelated material owner becomes private during compilation', async () => {
  const r = fixture();
  const db = new Database(r.f.dbPath);
  db.prepare(
    "INSERT INTO items(id,parent_id,summary,intent,rationale,acceptance_criteria,profile,status,starred,context_hints,created_at,updated_at,categories) SELECT 'preview-material-owner',NULL,summary,intent,rationale,acceptance_criteria,profile,status,starred,context_hints,created_at,updated_at,categories FROM items WHERE id='studio'",
  ).run();
  const material = r.f.artifacts.save({
    itemId: 'preview-material-owner',
    filename: 'reviewed-preview.txt',
    title: 'Explicit public preview material',
    bytes: Buffer.from('Preview material that becomes private'),
    sessionId: 'planning',
  });
  r.input.selection.artifacts = [
    { artifactId: material.id, revision: material.revision, sha256: material.sha256 },
  ];
  const parent = r.f.work.read('studio', r.f.actor);
  const compiled = vi.fn();
  const compile = TelosSourceCapture.prototype.previewAdvisorDraft;
  vi.spyOn(TelosSourceCapture.prototype, 'previewAdvisorDraft').mockImplementationOnce(
    async function (this: TelosSourceCapture, raw, actor) {
      const preview = await compile.call(this, raw, actor);
      compiled(preview.packet.context.artifacts);
      db.prepare("UPDATE items SET profile='lifeops' WHERE id='preview-material-owner'").run();
      return preview;
    },
  );
  try {
    await expect(r.owner().preview(r.input, r.f.actor)).rejects.toThrow(
      'advisor material unavailable',
    );
    expect(compiled).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining(r.input.selection.artifacts[0])]),
    );
    expect(r.f.work.read('studio', r.f.actor)).toEqual(parent);
    expect(r.f.events.getOrdinaryInitialCommandId('planning')).toBeUndefined();
  } finally {
    db.close();
  }
});

it('rechecks compiled material in the borrowed work transaction after source retention and rolls everything back', async () => {
  const r = fixture();
  const material = r.f.material;
  const original = r.f.artifacts.read(material.id, material.revision);
  r.input.selection.artifacts = [
    { artifactId: material.id, revision: material.revision, sha256: material.sha256 },
  ];
  const preview = await r.owner().preview(r.input, r.f.actor);
  const input = { ...r.input, previewSha256: preview.sha256 };
  const parent = r.f.work.read('studio', r.f.actor);
  const db = new Database(r.f.dbPath);
  const counts = () =>
    ['items', 'telos_artifact_revisions', 'telos_work_sources', 'telos_work_commands'].map(
      (table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
    );
  const before = counts();
  const borrow = TelosArtifactStore.borrowConnection.bind(TelosArtifactStore);
  const retained = vi.fn();
  vi.spyOn(TelosArtifactStore, 'borrowConnection').mockImplementationOnce((database) => {
    const artifacts = borrow(database);
    const save = artifacts.save.bind(artifacts);
    vi.spyOn(artifacts, 'save').mockImplementationOnce((packet) => {
      const result = save(packet);
      retained();
      database
        .prepare('UPDATE telos_artifact_revisions SET bytes=? WHERE id=? AND revision=?')
        .run(
          Buffer.from('Corrupted inside the retaining transaction'),
          material.id,
          material.revision,
        );
      return result;
    });
    return artifacts;
  });
  try {
    await expect(r.owner().save(input, r.f.actor)).rejects.toThrow('advisor material unavailable');
    expect(retained).toHaveBeenCalledOnce();
    expect(counts()).toEqual(before);
    expect(r.f.work.read('studio', r.f.actor)).toEqual(parent);
    expect(r.f.artifacts.read(material.id, material.revision).bytes).toEqual(original.bytes);
    expect(r.f.work.advisorDraftReceipt(input, r.f.actor)).toBeUndefined();
    expect((await r.owner().save(input, r.f.actor)).work.sources).toHaveLength(1);
  } finally {
    db.close();
  }
});

it('atomically saves a reviewed child draft with proposed brief and exact planning provenance while leaving all execution unallocated', async () => {
  const r = fixture();
  const parent = r.f.work.read('studio', r.f.actor);
  const preview = await r.owner().preview(r.input, r.f.actor);
  expect(JSON.parse(preview.packet.brief.text)).toMatchObject({
    parentId: 'studio',
    expectedParentRevision: parent.revision,
    proposed: r.input.proposed,
  });
  expect(preview.packet.context.boundary).toEqual(r.input.selection.boundary);
  expect(preview.packet.context.messages.map((message) => message.messageId)).toEqual([
    'draft-choice',
  ]);
  const save = { ...r.input, previewSha256: preview.sha256 };
  const receipt = await r.owner().save(save, r.f.actor);
  expect(receipt.work.itemId).not.toBe('studio');
  expect(receipt.work.parentId).toBe('studio');
  expect(receipt.work.kind).toBe('work_item');
  expect(receipt.work.assignments).toEqual([]);
  expect(receipt.work.attempts).toEqual([]);
  expect(receipt.work.links).toContainEqual(
    expect.objectContaining({
      role: 'origin',
      conversation: { namespace: 'mitzo', conversationId: 'planning' },
    }),
  );
  const record = r.f.work.readRecord(receipt.work.itemId, r.f.actor);
  expect(record).toMatchObject({
    summary: r.input.proposed.name,
    intent: r.input.proposed.desiredOutcome,
    categories: ['Music'],
  });
  const retained = r
    .capture()
    .read(receipt.work.itemId, receipt.work.sources[0].snapshotId, r.f.actor);
  expect(retained.packet).toEqual(preview.packet);
  expect(r.f.work.read('studio', r.f.actor)).toEqual(parent);
  expect(r.f.events.getOrdinaryInitialCommandId('planning')).toBeUndefined();
  r.f.restartOwners();
  expect(await r.owner().save(save, r.f.actor)).toEqual(receipt);
});

it('refines only the reviewed fields and preserves criteria and advisor context without allocating work', async () => {
  const r = fixture('refine');
  const original = r.f.work.readRecord('studio', r.f.actor);
  const links = r.f.work.read('studio', r.f.actor).links;
  const preview = await r.owner().preview(r.input, r.f.actor);
  const input = { ...r.input, previewSha256: preview.sha256 };
  const saved = await r.owner().save(input, r.f.actor);
  const record = r.f.work.readRecord('studio', r.f.actor);
  expect(record).toMatchObject({
    summary: r.input.proposed.name,
    intent: r.input.proposed.desiredOutcome,
    categories: [r.input.proposed.category],
    rationale: original.rationale,
    acceptanceCriteria: original.acceptanceCriteria,
    profile: original.profile,
    parentId: original.parentId,
  });
  expect(saved.work.links).toEqual(expect.arrayContaining(links));
  expect(saved.work.assignments).toEqual([]);
  expect(saved.work.attempts).toEqual([]);
  const db = new Database(r.f.dbPath);
  db.prepare("UPDATE items SET intent='A later reviewed revision' WHERE id='studio'").run();
  db.close();
  r.f.restartOwners();
  expect(await r.owner().save(input, r.f.actor)).toEqual(saved);
  expect(r.f.work.readRecord('studio', r.f.actor).intent).toBe('A later reviewed revision');
  expect(r.f.events.getOrdinaryInitialCommandId('planning')).toBeUndefined();
});

it('rolls child row source bytes backlinks and receipt back together when artifact retention is interrupted', async () => {
  const r = fixture();
  const preview = await r.owner().preview(r.input, r.f.actor);
  const input = { ...r.input, previewSha256: preview.sha256 };
  const counts = () => {
    const db = new Database(r.f.dbPath);
    try {
      return [
        'items',
        'telos_artifact_revisions',
        'telos_work_links',
        'telos_work_sources',
        'telos_work_commands',
      ].map((table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get());
    } finally {
      db.close();
    }
  };
  const before = counts();
  const borrow = TelosArtifactStore.borrowConnection.bind(TelosArtifactStore);
  vi.spyOn(TelosArtifactStore, 'borrowConnection').mockImplementationOnce((database) => {
    const artifacts = borrow(database);
    const save = artifacts.save.bind(artifacts);
    vi.spyOn(artifacts, 'save').mockImplementationOnce((packet) => {
      save(packet);
      throw new Error('source retention interrupted');
    });
    return artifacts;
  });
  await expect(r.owner().save(input, r.f.actor)).rejects.toThrow('source retention interrupted');
  expect(counts()).toEqual(before);
  expect(r.f.work.advisorDraftReceipt(input, r.f.actor)).toBeUndefined();
  expect((await r.owner().save(input, r.f.actor)).work.sources).toHaveLength(1);
});

it('rechecks operator and bound advisor purpose after source compilation and refuses private or unrelated saves', async () => {
  const r = fixture();
  const compile = TelosSourceCapture.prototype.previewAdvisorDraft;
  vi.spyOn(TelosSourceCapture.prototype, 'previewAdvisorDraft').mockImplementationOnce(
    async function (this: TelosSourceCapture, input, actor) {
      const preview = await compile.call(this, input, actor);
      r.assertAuthorized.mockImplementation(() => {
        throw new Error('operator revoked during source compilation');
      });
      return preview;
    },
  );
  const parent = r.f.work.read('studio', r.f.actor);
  await expect(r.owner().preview(r.input, r.f.actor)).rejects.toThrow('operator revoked');
  expect(r.f.work.read('studio', r.f.actor)).toEqual(parent);
  r.assertAuthorized.mockImplementation(() => {});
  await expect(
    r.owner().preview(r.input, { kind: 'conversation', id: 'planning' }),
  ).rejects.toThrow('Interactive operator authority');
  await expect(
    r
      .owner()
      .preview(
        { ...r.input, operation: 'refine', parentId: null, expectedParentRevision: null },
        r.f.actor,
      ),
  ).rejects.toThrow('Exact bound advisor draft scope');
  const db = new Database(r.f.dbPath);
  db.prepare("UPDATE items SET profile='lifeops' WHERE id='studio'").run();
  db.close();
  await expect(r.owner().preview(r.input, r.f.actor)).rejects.toThrow('private case storage');
});

it.each([
  { category: 'Planning', expected: ['Planning', 'Mitzo'] },
  { category: 'Mitzo', expected: ['Mitzo'] },
])(
  'replaces only the primary category and preserves secondary categories for $category',
  async ({ category, expected }) => {
    const r = fixture('refine');
    const db = new Database(r.f.dbPath);
    db.prepare('UPDATE items SET categories=\'["Job","Mitzo"]\' WHERE id=\'studio\'').run();
    db.close();
    r.input.expectedRevision = r.f.work.read('studio', r.f.actor).revision;
    r.input.proposed.category = category;
    const preview = await r.owner().preview(r.input, r.f.actor);
    await r.owner().save({ ...r.input, previewSha256: preview.sha256 }, r.f.actor);
    expect(r.f.work.readRecord('studio', r.f.actor).categories).toEqual(expected);
  },
);

it('refuses a hidden item type change during refinement in both source preview and the atomic work owner', async () => {
  const r = fixture('refine');
  const before = r.f.work.read('studio', r.f.actor);
  const proposed = { ...r.input.proposed, type: 'work_item' as const };
  await expect(r.owner().preview({ ...r.input, proposed }, r.f.actor)).rejects.toThrow(
    'Refinement cannot change item type',
  );
  const preview = await r.owner().preview(r.input, r.f.actor);
  expect(() =>
    r.f.work.saveAdvisorDraft(
      { ...r.input, proposed, previewSha256: preview.sha256 },
      r.f.actor,
      () => {
        throw new Error('Source retention must not run');
      },
      () => {},
    ),
  ).toThrow('Refinement cannot change item type');
  expect(r.f.work.read('studio', r.f.actor)).toEqual(before);
});

async function savedChildWithParentMaterial() {
  const r = fixture();
  const material = r.f.material;
  const pin = { artifactId: material.id, revision: material.revision, sha256: material.sha256 };
  r.input.selection.artifacts = [pin];
  const preview = await r.owner().preview(r.input, r.f.actor);
  const receipt = await r.owner().save({ ...r.input, previewSha256: preview.sha256 }, r.f.actor);
  const host = createTelosWorkRoleHost({
    dbPath: () => r.f.dbPath,
    events: r.f.events,
    ordinaryConversation: (id) => id === 'planning',
    workspaces: () => {
      throw new Error('Context review must not prepare a workspace');
    },
    resolvePreparation: async () => {
      throw new Error('Context review must not resolve a runtime');
    },
    authorizeSettings: async () => {},
  });
  const request = {
    actor: r.f.actor,
    signal: new AbortController().signal,
    assertAuthorized: r.assertAuthorized,
    raw: {
      itemId: receipt.work.itemId,
      role: 'advisor',
      advisorPurpose: 'refine',
      sourceSnapshotIds: receipt.work.sources.map((source) => source.snapshotId),
      artifactRefs: receipt.work.sources.flatMap((source) => source.artifacts),
    },
  };
  return { ...r, pin, receipt, host, request };
}

it('opens saved child advisor context with its exact reviewed parent material without inheriting arbitrary parent assets', async () => {
  const r = await savedChildWithParentMaterial();
  expect(r.f.artifacts.read(r.pin.artifactId, r.pin.revision).itemId).toBe('studio');
  const reviewed = await r.host.context(r.request);
  expect(reviewed.itemId).toBe(r.receipt.work.itemId);
  expect(reviewed.sources).toEqual(r.receipt.work.sources);
  expect(reviewed.artifacts).toContainEqual(r.pin);
  expect(r.receipt.work.assignments).toEqual([]);
  expect(r.receipt.work.attempts).toEqual([]);
  expect(r.f.events.getOrdinaryInitialCommandId('planning')).toBeUndefined();
});

it.each(['parent', 'sibling'] as const)(
  'refuses unpinned %s material when opening a saved child role context',
  async (owner) => {
    const r = await savedChildWithParentMaterial();
    if (owner === 'sibling') {
      const db = new Database(r.f.dbPath);
      db.prepare(
        "INSERT INTO items(id,parent_id,summary,intent,rationale,acceptance_criteria,profile,status,starred,context_hints,created_at,updated_at,categories) SELECT 'sibling',NULL,summary,intent,rationale,acceptance_criteria,profile,status,starred,context_hints,created_at,updated_at,categories FROM items WHERE id='studio'",
      ).run();
      db.close();
    }
    const other = r.f.artifacts.save({
      itemId: owner === 'parent' ? 'studio' : 'sibling',
      filename: 'not-reviewed.txt',
      title: 'Not in the selected child source',
      bytes: Buffer.from('Do not inherit these bytes'),
      sessionId: 'planning',
    });
    const pin = { artifactId: other.id, revision: other.revision, sha256: other.sha256 };
    await expect(
      r.host.context({
        ...r.request,
        raw: { ...r.request.raw, artifactRefs: [...r.request.raw.artifactRefs, pin] },
      }),
    ).rejects.toThrow('unavailable');
  },
);

it('refuses reviewed parent material after its owning item becomes private', async () => {
  const r = await savedChildWithParentMaterial();
  const db = new Database(r.f.dbPath);
  db.prepare("UPDATE items SET profile='lifeops' WHERE id='studio'").run();
  db.close();
  await expect(r.host.context(r.request)).rejects.toThrow('unavailable');
});

it('does not grant retained parent material when its exact child source snapshot was not selected', async () => {
  const r = await savedChildWithParentMaterial();
  await expect(
    r.host.context({
      ...r.request,
      raw: { ...r.request.raw, sourceSnapshotIds: [], artifactRefs: [r.pin] },
    }),
  ).rejects.toThrow('unavailable');
});
