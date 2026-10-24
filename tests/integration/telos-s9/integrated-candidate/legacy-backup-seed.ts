import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { TelosArtifactStore } from '../../../../server/telos-artifact-store';
import { TelosWorkStore } from '../../../../server/telos-work-store';

/** Initial synthetic legacy state only. Actual accepted MGMT upgraded DDL,
 * real Telos schema enrollment and artifact owners; no inferred assignments. */
export function createLegacyBackupSeed() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 's9-legacy-seed-'));
  const dbPath = join(root, 'legacy.db'),
    db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  const base = new URL(
    '../../../../server/__tests__/fixtures/telos-canonical-3077b7b4/',
    import.meta.url,
  );
  const schema = readFileSync(new URL('upgraded.sql', base), 'utf8');
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', base), 'utf8'));
  expect(createHash('sha256').update(schema).digest('hex')).toBe(manifest.schemas.upgraded);
  db.exec(schema);
  const stamp = '2025-01-02T03:04:05+00:00';
  const hints = {
    repos: ['example/old-repo'],
    paths: ['notes/legacy.md'],
    issues: ['#41'],
    doc_ids: ['legacy-document'],
    people: ['Original Person'],
    jira_keys: ['LEGACY-2'],
    keywords: ['preserve'],
    session_ids: ['legacy-hint-is-not-lead'],
    task_hint: 'Retain the exact older intent.',
    future_hint: { preserve: true },
  };
  for (const [id, parent, summary, profile, status, context] of [
    ['legacy-parent', null, 'Legacy family', 'manual', 'active', {}],
    ['legacy-known', 'legacy-parent', 'Known legacy provenance', 'work', 'snoozed', hints],
    [
      'legacy-unknown',
      'legacy-parent',
      'Unknown legacy provenance',
      'manual',
      'active',
      { session_ids: ['missing-historical-session'], task_hint: 'Do not infer an assignment.' },
    ],
  ] as const) {
    db.prepare(
      `INSERT INTO items(id,parent_id,summary,intent,rationale,acceptance_criteria,profile,status,priority,starred,urgency,snoozed_until,goal_id,idempotency_key,context_hints,first_seen,last_seen,created_at,updated_at,categories) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      parent,
      summary,
      'Keep original intent — Καλημέρα',
      'Original rationale',
      JSON.stringify(['Exact old fields', 'No guessed assignment']),
      profile,
      status,
      9,
      1,
      0.7,
      status === 'snoozed' ? '2026-11-01' : null,
      'legacy-accounting-goal',
      'historical-' + id,
      JSON.stringify(context),
      '2024-01-01',
      '2025-01-03',
      stamp,
      '2025-01-03',
      JSON.stringify(['Legacy']),
    );
    db.prepare(
      'INSERT INTO history(item_id,old_status,new_status,changed_at) VALUES(?,NULL,?,?)',
    ).run(id, status, stamp);
  }
  const snippet = 'Unabridged original exchange. '.repeat(45) + 'EXACT END OF LEGACY SOURCE';
  db.prepare('INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?)').run(
    'known-source',
    'legacy-known',
    'manual',
    'original-exchange',
    'codex://threads/recorded-original',
    'Recorded original exchange',
    'Original Person',
    stamp,
    snippet,
  );
  db.prepare('INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?)').run(
    'unknown-source',
    'legacy-unknown',
    'manual',
    'unattributed-source',
    '',
    'Unattributed imported note',
    '',
    '',
    'Unknown author and source date must remain unknown.',
  );
  db.prepare('INSERT INTO links VALUES(?,?,?,?,?,?,?)').run(
    'external-link',
    'legacy-known',
    'design_doc',
    'https://example.invalid/legacy',
    'Historical reference',
    'Preserved link description',
    stamp,
  );
  const artifacts = new TelosArtifactStore(dbPath);
  const bytes = [
    '# Historical revision one\n\nKeep these exact older bytes.\n',
    '# Historical revision two\n\nLater bytes must not replace an explicit r1 reference.\n',
  ];
  const save = (content: string, requestId: string) =>
    artifacts.save({
      itemId: 'legacy-known',
      filename: 'historical-plan.md',
      title: 'Historical plan',
      bytes: Buffer.from(content),
      sessionId: 'external-codex:historical-source',
      requestId,
    });
  const r1 = save(bytes[0], 'legacy-r1'),
    r2 = save(bytes[1], 'legacy-r2');
  db.prepare('INSERT INTO links VALUES(?,?,?,?,?,?,?)').run(
    'pinned-r1',
    'legacy-known',
    'artifact',
    r1.url,
    'Explicit historical revision one',
    'Pinned r1 survives restore',
    stamp,
  );
  const retained = () =>
    Object.fromEntries(
      ['items', 'sources', 'links', 'history'].map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
      ]),
    );
  const before = retained();
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE name='telos_work_kinds'").get(),
  ).toBeUndefined();
  const actor = { kind: 'operator' as const, id: 'synthetic-legacy-enrollment' };
  const first = new TelosWorkStore(dbPath, { ordinaryConversation: () => false });
  const firstRead = ['legacy-parent', 'legacy-known', 'legacy-unknown'].map((id) => ({
    work: first.read(id, actor),
    record: first.readRecord(id, actor),
  }));
  first.close();
  expect(retained()).toEqual(before);
  const second = new TelosWorkStore(dbPath, { ordinaryConversation: () => false });
  const secondRead = ['legacy-parent', 'legacy-known', 'legacy-unknown'].map((id) => ({
    work: second.read(id, actor),
    record: second.readRecord(id, actor),
  }));
  second.close();
  expect(secondRead).toEqual(firstRead);
  expect(retained()).toEqual(before);
  artifacts.close();
  return {
    db,
    dbPath,
    facts: {
      schemaOwner: manifest.owner,
      upgradedDdlHash: manifest.schemas.upgraded,
      legacyDdlSource: manifest.legacy,
      enrollment:
        'Actual TelosWorkStore constructor twice over accepted exported upgraded DDL; not execution of historical Python migration.',
      before,
      afterRepeatedEnrollment: retained(),
      firstRead,
      secondRead,
      hints,
      snippet,
      artifacts: [r1, r2],
      artifactBytes: bytes,
    },
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
