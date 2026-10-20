import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCollaborationRetainedArtifactFixture } from './fixtures/collaboration-retained-artifacts.js';
import { EventStore } from '../event-store.js';
import { createCollaborationContextSource } from '../collaboration-context-source.js';
import { compileCollaborationSourceContext } from '../collaboration-context-compiler.js';
let retained: ReturnType<typeof createCollaborationRetainedArtifactFixture>;
let events: EventStore;
beforeEach(() => {
  retained = createCollaborationRetainedArtifactFixture();
  events = new EventStore(':memory:');
  for (const id of ['source', 'origin'])
    events.upsertSession({ sessionId: id, conversationSource: 'mitzo' });
});
afterEach(() => {
  events.close();
  retained.close();
  vi.restoreAllMocks();
});
function save(text: string, sessionId: string, filename = 'plan.md') {
  return retained.store.save({
    itemId: retained.itemId,
    filename,
    title: 'Plan',
    bytes: Buffer.from(text),
    sessionId,
    sourcePath: '/synthetic/plan.md',
  });
}
function pin(artifact: ReturnType<typeof save>) {
  return {
    kind: 'retainedArtifactVersion' as const,
    artifactId: artifact.id,
    revision: artifact.revision,
    sha256: artifact.sha256,
  };
}
function setup(text = 'Visible source', onCurrent?: () => void) {
  const sequence = events.append('source', 'user_message', { messageId: 'question', text });
  let allowed = true;
  const authorizeConversation = vi.fn(async (id: string) => {
    if (!allowed || id !== 'source') throw Error('source access revoked');
  });
  const source = () =>
    createCollaborationContextSource({
      store: events,
      retainedArtifacts: retained.store,
      authorizeConversation,
      assertConversationCurrent: (id: string) => {
        if (!allowed || id !== 'source') throw Error('source access revoked');
        onCurrent?.();
      },
    });
  const selection = {
    requestId: randomUUID(),
    expectedMembershipRevision: 1,
    sourceConversationId: 'source',
    boundary: { sequence, messageId: 'question' },
    mode: 'selected' as const,
    messageIds: [],
    artifacts: [] as ReturnType<typeof pin>[],
    purpose: 'Review',
    joiningBrief: 'Exact saved version',
  };
  return {
    source,
    selection,
    authorizeConversation,
    revoke: () => {
      allowed = false;
    },
  };
}
it('hydrates selected r2 through actual origin association while r3 exists and the original transcript is hidden', async () => {
  save('first', 'source');
  const second = save('  exact r2\r\nπ  ', 'origin');
  save('latest must not replace r2', 'another-editor');
  events.hideSession('origin');
  const f = setup();
  const source = f.source();
  const draft = await compileCollaborationSourceContext(
    { ...f.selection, artifacts: [pin(second)] },
    source,
  );
  expect(draft.artifacts).toEqual([
    {
      ...pin(second),
      retention: 'independent',
      itemId: retained.itemId,
      filename: 'plan.md',
      title: 'Plan',
      provenance: {
        sessionId: 'origin',
        sourceKind: 'session_artifact',
        sourcePath: '/synthetic/plan.md',
      },
      mediaType: 'application/octet-stream',
      sizeBytes: Buffer.byteLength('  exact r2\r\nπ  '),
      contentBase64: Buffer.from('  exact r2\r\nπ  ').toString('base64'),
    },
  ]);
  expect(draft.artifacts[0]).not.toHaveProperty('sourceConversationId');
  expect(f.authorizeConversation.mock.calls.every(([id]) => id === 'source')).toBe(true);
  expect(events.getSession('origin')?.isHidden).toBe(true);
  expect(() => source.assertCurrentAtSave()).not.toThrow();
  expect(draft.capacity.status).toBe('unverified');
});
it('uses actual visible versioned links for association and includes only exact references in So far', async () => {
  const first = save('first', 'origin');
  const second = save('second', 'another-origin');
  save('third', 'another-editor');
  const f = setup(`[Plan](/api/telos/artifacts/${second.id}?revision=2)`);
  const selected = await compileCollaborationSourceContext(
    { ...f.selection, artifacts: [pin(first)] },
    f.source(),
  );
  expect(selected.artifacts.map((a) => a.revision)).toEqual([1]);
  const complete = await compileCollaborationSourceContext(
    { ...f.selection, requestId: randomUUID(), mode: 'conversation_so_far' },
    f.source(),
  );
  expect(complete.artifacts.map((a) => [a.revision, a.sha256])).toEqual([[2, second.sha256]]);
});
it('refuses unrelated same-Work material and bare aliases before retained byte reads', async () => {
  const other = save('unrelated', 'origin');
  const f = setup();
  const bytes = vi.spyOn(retained.store, 'readBoundedRevision');
  await expect(
    compileCollaborationSourceContext({ ...f.selection, artifacts: [pin(other)] }, f.source()),
  ).rejects.toThrow();
  const { kind: _kind, ...bare } = pin(other);
  void _kind;
  await expect(
    compileCollaborationSourceContext({ ...f.selection, artifacts: [bare] }, f.source()),
  ).rejects.toThrow();
  expect(bytes).not.toHaveBeenCalled();
});
it('does not add all origin revisions or permit an unreferenced retained version in So far', async () => {
  save('first', 'source');
  const second = save('second', 'origin');
  const f = setup();
  const complete = await compileCollaborationSourceContext(
    { ...f.selection, mode: 'conversation_so_far' },
    f.source(),
  );
  expect(complete.artifacts).toEqual([]);
  await expect(
    compileCollaborationSourceContext(
      {
        ...f.selection,
        requestId: randomUUID(),
        mode: 'conversation_so_far',
        artifacts: [pin(second)],
      },
      f.source(),
    ),
  ).rejects.toThrow();
});
it('renews actual item privacy and source authority at the synchronous final save fence', async () => {
  const selected = save('selected', 'source');
  const f = setup();
  const source = f.source();
  await compileCollaborationSourceContext({ ...f.selection, artifacts: [pin(selected)] }, source);
  const db = new Database(retained.path);
  db.prepare('UPDATE items SET profile=? WHERE id=?').run('LifeOps', retained.itemId);
  db.close();
  expect(() => source.assertCurrentAtSave()).toThrow();
  const db2 = new Database(retained.path);
  db2.prepare('UPDATE items SET profile=? WHERE id=?').run('work', retained.itemId);
  db2.close();
  f.revoke();
  expect(() => source.assertCurrentAtSave()).toThrow();
});

it.each(['bytes', 'origin'] as const)(
  'finishes every original retained %s witness after callbacks for later artifacts',
  async (fault) => {
    const first = save('origin', 'source', 'first.md');
    const selected = save('selected', 'origin', 'first.md');
    const second = save('second', 'source', 'second.md');
    let armed = false,
      calls = 0,
      mutated = false;
    const f = setup('Visible source', () => {
      if (!armed || ++calls !== 8) return;
      const db = new Database(retained.path);
      try {
        if (fault === 'bytes')
          db.prepare('UPDATE telos_artifact_revisions SET bytes=? WHERE id=? AND revision=?').run(
            Buffer.from('replaced'),
            selected.id,
            selected.revision,
          );
        else
          db.prepare('DELETE FROM telos_artifact_revisions WHERE id=? AND revision=?').run(
            first.id,
            first.revision,
          );
        mutated = true;
      } finally {
        db.close();
      }
    });
    const source = f.source();
    await compileCollaborationSourceContext(
      { ...f.selection, artifacts: [pin(selected), pin(second)] },
      source,
    );
    armed = true;
    expect(() => source.assertCurrentAtSave()).toThrow();
    expect(mutated).toBe(true); // The later artifact's callback really ran the mutation.
  },
);

it('does not substitute latest for an unversioned So-far link but permits an explicit exact Selected version', async () => {
  const first = save('first', 'origin');
  save('second', 'another-editor');
  const f = setup(`[Plan](/api/telos/artifacts/${first.id})`);
  const selected = await compileCollaborationSourceContext(
    { ...f.selection, artifacts: [pin(first)] },
    f.source(),
  );
  expect(selected.artifacts.map((a) => a.revision)).toEqual([1]);
  await expect(
    compileCollaborationSourceContext(
      { ...f.selection, requestId: randomUUID(), mode: 'conversation_so_far' },
      f.source(),
    ),
  ).rejects.toThrow();
});
it('counts repeated visible links as one exact artifact across more than one hundred messages', async () => {
  const saved = save('selected', 'origin');
  const text = `[Plan](/api/telos/artifacts/${saved.id}?revision=1)`;
  const f = setup(text);
  let sequence = f.selection.boundary.sequence;
  for (let n = 1; n <= 100; n++)
    sequence = events.append('source', 'user_message', { messageId: `user${n}`, text });
  const draft = await compileCollaborationSourceContext(
    { ...f.selection, mode: 'conversation_so_far', boundary: { sequence, messageId: 'user100' } },
    f.source(),
  );
  expect(draft.messages).toHaveLength(101);
  expect(draft.artifacts).toHaveLength(1);
  expect(draft.artifacts[0]).toMatchObject(pin(saved));
});
it('finishes a metadata catalog after late authority callbacks without hydrating bytes', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T00:00:00.000Z'));
  const first = save('first', 'source', 'first.md');
  vi.advanceTimersByTime(1);
  const second = save('second', 'source', 'second.md');
  vi.useRealTimers();
  const f = setup();
  const visible = events.openCollaborationVisibleSource('source', f.selection.boundary);
  const { createCollaborationRetainedContext } =
    await import('../collaboration-retained-context-source.js');
  let secondObserved = false,
    attacked = false;
  const actualMetadata = retained.store.metadataForRevision.bind(retained.store);
  vi.spyOn(retained.store, 'metadataForRevision').mockImplementation((...args) => {
    const value = actualMetadata(...args);
    if (value.id === second.id) secondObserved = true;
    return value;
  });
  const bytes = vi.spyOn(retained.store, 'readBoundedRevision');
  const context = createCollaborationRetainedContext({
    source: visible,
    artifacts: retained.store,
    authorize: async () => {
      if (secondObserved && !attacked) {
        attacked = true;
        const db = new Database(retained.path);
        db.prepare('UPDATE telos_artifact_revisions SET title=? WHERE id=?').run(
          'changed after earlier observation',
          first.id,
        );
        db.close();
      }
    },
    assertSourceCurrent: () => visible.assertCurrent(),
  });
  await context.catalog();
  expect(attacked).toBe(true);
  expect(() => context.assertOwnedCurrent()).toThrow();
  expect(bytes).not.toHaveBeenCalled();
});
