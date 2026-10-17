import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { removePending } from '@mitzo/harness';
import type { TelosSourceMaterialCursor } from '@mitzo/protocol';
import type { TelosArtifactMetadata } from '../telos-artifact-store.js';
import { randomUUID } from 'node:crypto';
import { createTelosSourceApprovalData } from './fixtures/telos-source-approval-data.js';

const closes: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  closes
    .splice(0)
    .reverse()
    .forEach((close) => close());
});
function fixture() {
  const f = createTelosSourceApprovalData();
  closes.push(() => f.close());
  const db = new Database(f.dbPath);
  closes.push(() => db.close());
  return { ...f, db };
}
function revisions(f: ReturnType<typeof fixture>, count = 205) {
  const saved = Array.from({ length: count }, (_, i) =>
    f.artifacts.save({
      itemId: 'studio',
      filename: 'retained-history.md',
      title: 'Retained history',
      bytes: Buffer.from('Exact historical revision ' + (i + 1)),
      sessionId: 'planning',
    }),
  );
  // Every revision ties on timestamp: id and revision must both participate.
  f.db
    .prepare('UPDATE telos_artifact_revisions SET created_at=? WHERE session_id=?')
    .run('2026-10-17T00:00:00.000Z', 'planning');
  return saved;
}
async function permission(f: ReturnType<typeof fixture>) {
  const request = await f.request({ kind: 'create', marker: 'native' });
  return String(request.permId);
}

it('keeps text-only review usable above100 retained revisions and reports independent material continuation', async () => {
  const f = fixture();
  revisions(f, 101);
  const permId = await permission(f);
  const review = await f.service.review(permId, 'planning', f.actor);
  expect(review.messages.map((m) => m.messageId)).toContain('approved');
  expect(review.artifacts).toHaveLength(100);
  expect(review.artifactsHasMore).toBe(true);
  expect(review.artifactCursor).toBeTruthy();
  const message = review.messages.find((m) => m.messageId === 'approved')!;
  const preview = await f.service.preview(
    permId,
    {
      sessionId: 'planning',
      requestId: randomUUID(),
      proposalSha256: review.proposalSha256,
      selection: {
        mode: 'selected',
        boundary: { sequence: message.sequence, messageId: message.messageId },
        messageIds: [message.messageId],
        artifacts: [],
      },
    },
    f.actor,
  );
  expect(preview.preview.packet.context.artifacts).toEqual([]);
  expect(f.counts().canonicalCreates).toBe(0);
});

it('enumerates every exact revision across timestamp/id ties using bounded metadata pages', () => {
  const f = fixture();
  const saved = revisions(f);
  const all: TelosArtifactMetadata[] = [];
  let cursor: TelosSourceMaterialCursor | undefined;
  do {
    const page = f.artifacts.sourceMaterialPage('planning', cursor);
    expect(page.artifacts.length).toBeLessThanOrEqual(100);
    expect(page.artifacts.every((a) => !('bytes' in a))).toBe(true);
    all.push(...page.artifacts);
    if (!page.hasMore) break;
    expect(page.cursor).not.toEqual(cursor);
    cursor = page.cursor!;
  } while (all.length < 400);
  expect(all).toHaveLength(206);
  expect(new Set(all.map((a) => a.id + ':' + a.revision)).size).toBe(206);
  for (const original of saved)
    expect(all.find((a) => a.id === original.id && a.revision === original.revision)?.sha256).toBe(
      original.sha256,
    );
  expect(all.filter((a) => a.id === saved[0].id).map((a) => a.revision)).toEqual(
    saved.map((a) => a.revision),
  );
});

it('filters private prefixes before bounding the page, including every accepted LifeOps spelling', () => {
  const f = fixture();
  revisions(f, 2);
  for (const [i, profile] of ['LifeOps', 'life-ops', 'LIFE_OPS', 'life ops'].entries()) {
    const id = 'private-' + i;
    f.db.prepare('INSERT INTO items(id,summary,profile) VALUES(?,?,?)').run(id, id, profile);
    for (let j = 0; j < 30; j++)
      f.artifacts.save({
        itemId: id,
        filename: 'private-' + j + '.md',
        title: 'Private',
        bytes: Buffer.from('PRIVATE'),
        sessionId: 'planning',
      });
  }
  f.db
    .prepare("UPDATE telos_artifact_revisions SET created_at='2000' WHERE item_id LIKE 'private-%'")
    .run();
  const page = f.artifacts.sourceMaterialPage('planning');
  expect(page.artifacts).toHaveLength(3);
  expect(page.artifacts.every((a) => a.itemId === 'studio')).toBe(true);
  expect(page.hasMore).toBe(false);
});

it('can select an older exact revision discovered on a later page without substituting latest', async () => {
  const f = fixture();
  const saved = revisions(f);
  const permId = await permission(f);
  const review = await f.service.review(permId, 'planning', f.actor);
  const page = await f.service.materials(
    permId,
    {
      sessionId: 'planning',
      toolUseId: review.toolUseId,
      proposalSha256: review.proposalSha256,
      after: review.artifactCursor!,
    },
    f.actor,
  );
  const original = saved[149];
  expect(
    page.artifacts.find((a) => a.artifactId === original.id && a.revision === 150)?.sha256,
  ).toBe(original.sha256);
  const message = review.messages.find((m) => m.messageId === 'approved')!;
  const input = {
    sessionId: 'planning',
    requestId: randomUUID(),
    proposalSha256: review.proposalSha256,
    selection: {
      mode: 'selected' as const,
      boundary: { sequence: message.sequence, messageId: message.messageId },
      messageIds: [message.messageId],
      artifacts: [
        { artifactId: original.id, revision: original.revision, sha256: original.sha256 },
      ],
    },
  };
  const preview = await f.service.preview(permId, input, f.actor);
  expect(preview.preview.packet.context.artifacts).toHaveLength(1);
  expect(preview.preview.packet.context.artifacts[0]).toMatchObject({
    revision: 150,
    sha256: original.sha256,
    contentBase64: Buffer.from('Exact historical revision 150').toString('base64'),
  });
  expect(f.artifacts.read(original.id).revision).toBe(205);
});

it.each(['toolUseId', 'proposalSha256', 'sessionId'] as const)(
  'refuses material continuation bound to changed %s',
  async (field) => {
    const f = fixture();
    revisions(f, 101);
    const permId = await permission(f);
    const review = await f.service.review(permId, 'planning', f.actor);
    const input = {
      sessionId: 'planning',
      toolUseId: review.toolUseId,
      proposalSha256: review.proposalSha256,
      after: review.artifactCursor!,
      [field]: field === 'proposalSha256' ? '0'.repeat(64) : 'changed',
    };
    const before = f.retainedOwnerCounts();
    await expect(
      Promise.resolve().then(() => f.service.materials(permId, input, f.actor)),
    ).rejects.toThrow();
    expect(f.retainedOwnerCounts()).toEqual(before);
  },
);

it('keeps the compiler100 selected-material limit independent from discovery', async () => {
  const f = fixture();
  const saved = revisions(f, 101);
  const permId = await permission(f);
  const review = await f.service.review(permId, 'planning', f.actor);
  const message = review.messages.find((m) => m.messageId === 'approved')!;
  await expect(
    f.service.preview(
      permId,
      {
        sessionId: 'planning',
        requestId: randomUUID(),
        proposalSha256: review.proposalSha256,
        selection: {
          mode: 'selected',
          boundary: { sequence: message.sequence, messageId: message.messageId },
          messageIds: [message.messageId],
          artifacts: saved.map((a) => ({
            artifactId: a.id,
            revision: a.revision,
            sha256: a.sha256,
          })),
        },
      },
      f.actor,
    ),
  ).rejects.toThrow();
  expect(f.counts().canonicalCreates).toBe(0);
});

it('returns terminal retained recovery metadata without discovering later mutable materials', async () => {
  const f = fixture();
  const permId = await permission(f);
  const review = await f.service.review(permId, 'planning', f.actor);
  const message = review.messages.find((m) => m.messageId === 'approved')!;
  const input = {
    sessionId: 'planning',
    requestId: randomUUID(),
    proposalSha256: review.proposalSha256,
    selection: {
      mode: 'selected' as const,
      boundary: { sequence: message.sequence, messageId: message.messageId },
      messageIds: [message.messageId],
      artifacts: [],
    },
  };
  const preview = await f.service.preview(permId, input, f.actor);
  f.loseNextCanonicalResponse();
  await expect(
    f.service.approve(permId, { ...input, previewSha256: preview.preview.sha256 }, f.actor),
  ).rejects.toThrow();
  revisions(f, 101);
  const discover = vi.spyOn(f.artifacts, 'sourceMaterialPage').mockImplementation(() => {
    throw Error('Mutable discovery forbidden during recovery');
  });
  const recovered = await f.service.review(permId, 'planning', f.actor);
  expect(recovered.recovery?.preview).toEqual(preview.preview);
  expect(recovered.artifacts).toEqual([]);
  expect(recovered.artifactsHasMore).toBe(false);
  expect(recovered.artifactCursor).toBeNull();
  const page = await f.service.materials(
    permId,
    { sessionId: 'planning', toolUseId: review.toolUseId, proposalSha256: review.proposalSha256 },
    f.actor,
  );
  expect(page).toMatchObject({ artifacts: [], cursor: null, hasMore: false });
  expect(discover).not.toHaveBeenCalled();
});

it('preserves text and exact metadata at the existing100-row boundary', async () => {
  const f = fixture();
  revisions(f, 99);
  const permId = await permission(f);
  const review = await f.service.review(permId, 'planning', f.actor);
  expect(review.artifacts).toHaveLength(100);
  expect(review.messages.map((m) => m.messageId)).toContain('approved');
});
it('treats a denied-only remainder as terminal without exposing metadata or looping', () => {
  const f = fixture();
  revisions(f, 205);
  const first = f.artifacts.sourceMaterialPage('planning');
  expect(first.hasMore).toBe(true);
  f.db.prepare("UPDATE items SET profile='LifeOps' WHERE id='studio'").run();
  const terminal = f.artifacts.sourceMaterialPage('planning', first.cursor!);
  expect(terminal).toMatchObject({ artifacts: [], cursor: null, hasMore: false });
});
it('matches absent-profile compatibility rather than assuming every canonical fixture has that column', () => {
  const f = fixture();
  revisions(f, 2);
  f.db.exec('ALTER TABLE items DROP COLUMN profile');
  expect(f.artifacts.userUploadAllowed('studio')).toBe(true);
  const page = f.artifacts.sourceMaterialPage('planning');
  expect(page.artifacts).toHaveLength(3);
  expect(page.hasMore).toBe(false);
});

it('rechecks pending invocation ownership after the metadata read', async () => {
  const f = fixture();
  revisions(f, 101);
  const permId = await permission(f);
  const review = await f.service.review(permId, 'planning', f.actor);
  const original = f.artifacts.sourceMaterialPage.bind(f.artifacts);
  vi.spyOn(f.artifacts, 'sourceMaterialPage').mockImplementationOnce((...args) => {
    const page = original(...args);
    removePending(permId);
    return page;
  });
  expect(() =>
    f.service.materials(
      permId,
      {
        sessionId: 'planning',
        toolUseId: review.toolUseId,
        proposalSha256: review.proposalSha256,
        after: review.artifactCursor!,
      },
      f.actor,
    ),
  ).toThrow();
});
