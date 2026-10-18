import { afterEach, expect, it } from 'vitest';
import {
  createCanonicalAdvisorFixture,
  type CanonicalVariant,
} from './fixtures/telos-canonical-advisor.js';
const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
function fixture(variant: CanonicalVariant, operation: 'refine' | 'child') {
  const f = createCanonicalAdvisorFixture(variant, operation);
  cleanups.push(() => f.close());
  return f;
}

for (const variant of ['fresh', 'upgraded'] as const) {
  it.each(['item', 'source', 'receipt'] as const)(
    `CT02: canonical ${variant} rolls back the complete save after the %s write`,
    async (stage) => {
      const f = fixture(variant, 'child');
      const preview = await f.owner().preview(f.input, f.actor);
      const input = { ...f.input, previewSha256: preview.sha256 };
      const failpoint = {
        item: "AFTER INSERT ON items WHEN NEW.id != 'studio'",
        source: 'AFTER INSERT ON telos_work_sources',
        receipt: `AFTER INSERT ON telos_work_commands WHEN NEW.request_id = 'advisor:${input.requestId}'`,
      }[stage];
      const message = `CT02 injected after ${stage}`;
      f.db.exec(`CREATE TRIGGER ct02_injected_failure ${failpoint}
      BEGIN SELECT RAISE(ABORT,'${message}'); END`);
      const tables = [
        'items',
        'sources',
        'links',
        'history',
        'telos_work_kinds',
        'telos_work_sources',
        'telos_work_links',
        'telos_work_commands',
        'telos_artifact_revisions',
        'telos_artifact_save_requests',
      ];
      const snapshot = () =>
        Object.fromEntries(
          tables.map((table) => [table, f.db.prepare(`SELECT * FROM ${table}`).all()]),
        );
      const before = snapshot();
      const revision = f.work.read('studio', f.actor).revision;
      // This must reach the actual failpoint. An unrelated schema error cannot
      // count as transaction rollback coverage.
      await expect(f.owner().save(input, f.actor)).rejects.toThrow(message);
      expect(snapshot()).toEqual(before);
      expect(f.work.read('studio', f.actor).revision).toBe(revision);
      expect(f.db.pragma('foreign_key_check')).toEqual([]);
      f.db.exec('DROP TRIGGER ct02_injected_failure');
      const recovered = await f.owner().save(input, f.actor);
      expect(await f.owner().save(input, f.actor)).toEqual(recovered);
      expect(recovered.work.sources).toHaveLength(1);
    },
  );
}

for (const variant of ['fresh', 'upgraded'] as const) {
  it.each(['refine', 'child'] as const)(
    `CT01: canonical ${variant} schema supports advisor %s and exact replay`,
    async (operation) => {
      const f = fixture(variant, operation);
      const preview = await f.owner().preview(f.input, f.actor);
      const input = { ...f.input, previewSha256: preview.sha256 };
      const receipt = await f.owner().save(input, f.actor);
      const row = f.db.prepare('SELECT * FROM items WHERE id=?').get(receipt.work.itemId) as Record<
        string,
        unknown
      >;
      expect(f.work.readRecord(receipt.work.itemId, f.actor)).toMatchObject({
        summary: 'Reviewed plan',
        intent: 'Record clearly',
        categories: ['Music'],
        parentId: operation === 'child' ? 'studio' : null,
      });
      for (const name of ['first_seen', 'last_seen', 'created_at', 'updated_at']) {
        expect(typeof row[name]).toBe('string');
        expect(Number.isNaN(Date.parse(String(row[name])))).toBe(false);
      }
      if (operation === 'refine') {
        expect(row.first_seen).toBe(f.stamp);
        expect(row.last_seen).toBe(f.stamp);
        expect(row.created_at).toBe(f.stamp);
        expect(row.priority).toBe(8);
        expect(JSON.parse(String(row.acceptance_criteria))).toEqual(['Approved plan']);
        expect(JSON.parse(String(row.context_hints))).toMatchObject({
          people: ['Original person'],
          task_hint: 'Original hint',
        });
      } else {
        expect(row.priority).toBe(5);
        expect(row.first_seen).toBe(row.created_at);
        expect(row.last_seen).toBe(row.created_at);
      }
      expect(
        f.db
          .prepare('SELECT old_status,new_status,changed_at FROM history WHERE item_id=?')
          .all(receipt.work.itemId),
      ).toEqual([
        {
          old_status: null,
          new_status: 'active',
          changed_at: operation === 'child' ? row.created_at : f.stamp,
        },
      ]);
      expect(receipt.work.assignments).toEqual([]);
      expect(receipt.work.attempts).toEqual([]);
      expect(receipt.work.sources).toHaveLength(1);
      const count = () => f.db.prepare('SELECT COUNT(*) AS count FROM items').get();
      const beforeReplay = count();
      f.restartOwners();
      expect(await f.owner().save(input, f.actor)).toEqual(receipt);
      expect(count()).toEqual(beforeReplay);
      await expect(
        f
          .owner()
          .save({ ...input, proposed: { ...input.proposed, name: 'Changed identity' } }, f.actor),
      ).rejects.toThrow(/identity|different|changed|conflict/i);
      expect(count()).toEqual(beforeReplay);
      expect(f.db.pragma('foreign_key_check')).toEqual([]);
    },
  );
}
