import { createCanonicalAdvisorFixture } from '../../server/__tests__/fixtures/telos-canonical-advisor';
import { createTelosWorkRoleHost } from '../../server/telos-work-role-host';

/** Canonical synthetic database and actual review owner; no allocator/model/network. */
export async function reviewedContextBrowserData() {
  const f = createCanonicalAdvisorFixture('fresh', 'refine');
  try {
    const preview = await f.owner().preview(f.input, f.actor);
    const saved = await f.owner().save({ ...f.input, previewSha256: preview.sha256 }, f.actor);
    for (const [id, parent, title, intent] of [
      ['goal', null, 'Home recording album', 'Retain the reviewed album'],
      ['parent', 'goal', 'First recording session', 'Keep the agreed recording plan'],
    ])
      f.db
        .prepare(
          `INSERT INTO items(id,parent_id,summary,intent,profile,first_seen,last_seen,created_at,updated_at)
        VALUES(?,?,?,?,'manual',?,?,?,?)`,
        )
        .run(id, parent, title, intent, f.stamp, f.stamp, f.stamp, f.stamp);
    f.db.prepare("UPDATE items SET parent_id='parent' WHERE id='studio'").run();
    const failAllocation = () => {
      throw Error('Review must not allocate');
    };
    const host = createTelosWorkRoleHost({
      dbPath: () => f.dbPath,
      events: f.events,
      ordinaryConversation: (id) => id === 'planning',
      workspaces: failAllocation,
      resolvePreparation: failAllocation,
      authorizeSettings: async () => {},
    });
    const review = await host.review({
      actor: f.actor,
      signal: new AbortController().signal,
      assertAuthorized: () => {},
      raw: {
        itemId: 'studio',
        role: 'lead',
        sourceSnapshotIds: saved.work.sources.map((source) => source.snapshotId),
        artifactRefs: [
          { artifactId: f.material.id, revision: f.material.revision, sha256: f.material.sha256 },
        ],
      },
    });
    return { review, material: f.material, source: saved.work.sources[0] };
  } finally {
    f.close();
  }
}
