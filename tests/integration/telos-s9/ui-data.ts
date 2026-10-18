import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { TelosWorkStore } from '../../../server/telos-work-store';
import { TelosArtifactStore } from '../../../server/telos-artifact-store';

/** Actual canonical schema and persistence, with only synthetic rows/bytes.
 * Category persistence remains unavailable: category display invalidation is
 * separately exercised at the validated DTO transport boundary. */
export function createUiData() {
  const root = mkdtempSync(join(tmpdir(), 's9-ui-canonical-'));
  const path = join(root, 'telos.db');
  const db = new Database(path);
  db.exec(
    readFileSync(resolve('tests/integration/telos-s9/fixtures/canonical-schema.sql'), 'utf8'),
  );
  for (const [id, parentId, summary] of [
    ['outcome', null, 'Original outcome'],
    ['legacy', null, 'Legacy parent'],
    ['legacy-child', 'legacy', 'Real legacy child'],
  ] as const)
    db.prepare(
      'INSERT INTO items(id,parent_id,summary,intent,rationale,acceptance_criteria,profile,first_seen,last_seen,created_at,updated_at,context_hints) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      id,
      parentId,
      summary,
      'Deliver the independently reviewed result',
      'Retain ordinary work',
      '["Independent review recorded"]',
      'manual',
      '2026-10-16T10:00:00Z',
      '2026-10-16T10:00:00Z',
      '2026-10-16T10:00:00Z',
      '2026-10-17T11:00:00Z',
      JSON.stringify({
        repos: ['synthetic/repository'],
        people: ['Offline collaborator'],
        keywords: ['retained context'],
        task_hint: 'Review independently',
      }),
    );
  const work = new TelosWorkStore(path, { ordinaryConversation: () => false });
  const actor = { kind: 'operator' as const, id: 's9-offline-ui' };
  for (const [itemId, kind] of [
    ['outcome', 'outcome'],
    ['legacy-child', 'work_item'],
  ] as const)
    work.execute(
      {
        operation: 'classify',
        itemId,
        kind,
        requestId: 'kind-' + itemId,
        expectedRevision: work.read(itemId, actor).revision,
      },
      actor,
    );
  const artifacts = new TelosArtifactStore(path);
  const old = artifacts.save({
    itemId: 'outcome',
    filename: 'retained-plan.md',
    title: 'Selected retained plan',
    bytes: Buffer.from('OLDER REVIEWED REVISION'),
    sessionId: 'external-codex:s9-offline',
  });
  artifacts.save({
    itemId: 'outcome',
    filename: 'retained-plan.md',
    title: 'Selected retained plan',
    bytes: Buffer.from('LATER UNSELECTED REVISION'),
    sessionId: 'external-codex:s9-offline',
  });
  let generation = 0;
  const record = (id: string) => ({
    ...work.readRecord(id, actor),
    categories: [generation ? 'Updated category' : 'Original category'],
  });
  const legacy = (id: string): unknown => {
    const value = record(id);
    const children = (
      db.prepare('SELECT id FROM items WHERE parent_id=? ORDER BY id').all(id) as { id: string }[]
    ).map((row) => legacy(row.id));
    return {
      id,
      summary: value.summary,
      profile: value.profile,
      priority: (
        db.prepare('SELECT priority FROM items WHERE id=?').get(id) as { priority: number }
      ).priority,
      urgency: 1,
      starred: false,
      status: value.status,
      parentId: value.parentId,
      children,
      ageDays: 0,
      childCount: children.length,
      completedChildCount: 0,
      sources: [],
      links: [],
      goalId: null,
      contextHints: value.contextHints,
    };
  };
  return {
    record,
    work: (id: string) => work.read(id, actor),
    old,
    collection: () => ({ profiles: ['manual'], items: [legacy('outcome'), legacy('legacy')] }),
    update() {
      generation++;
      db.prepare(
        "UPDATE items SET summary='Updated outcome',status='acknowledged',updated_at='2026-10-17T12:00:00Z' WHERE id='outcome'",
      ).run();
    },
    readMaterial(revision: number) {
      return artifacts.read(old.id, revision);
    },
    setPriority(priority: number) {
      const source = process.env.S9_MGMT_SOURCE_ROOT;
      if (!source)
        throw Error(
          'S9_MGMT_SOURCE_ROOT must select the clean accepted MGMT owner for actual priority persistence',
        );
      const pin = JSON.parse(
        readFileSync(
          resolve('tests/integration/telos-s9/fixtures/canonical-schema-source.json'),
          'utf8',
        ),
      );
      for (const [name, sha] of Object.entries(pin.files))
        if (
          createHash('sha256')
            .update(readFileSync(resolve(source, name)))
            .digest('hex') !== sha
        )
          throw Error('MGMT source differs from pinned accepted owner');
      const result = execFileSync(
        'python3',
        [
          '-c',
          'import sys,json; from pathlib import Path; sys.dont_write_bytecode=True; sys.path.insert(0,str(Path(sys.argv[1])/"command_center")); from lib.todo.store import TodoStore; s=TodoStore(Path(sys.argv[2])); print(s.set_priority("outcome",json.loads(sys.argv[3]))); s.close()',
          resolve(source),
          path,
          String(priority),
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', TELOS_DB_PATH: path },
        },
      );
      if (result.trim() !== 'True') throw Error('Canonical priority owner rejected the save');
    },
    priority() {
      return (
        db.prepare("SELECT priority FROM items WHERE id='outcome'").get() as { priority: number }
      ).priority;
    },
    close() {
      work.close();
      artifacts.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
