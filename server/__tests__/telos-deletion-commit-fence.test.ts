import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createFreshTelosDatabaseFiles } from '../../packages/protocol/src/telos-sqlite-owners.js';
import { EventStore } from '../event-store.js';
import { TaskStore } from '../task-store.js';
import { TelosWorkStore } from '../telos-work-store.js';
const sqlite = createRequire(import.meta.url).resolve('better-sqlite3');
const closes: Array<() => void> = [];
afterEach(() => {
  for (const close of closes.splice(0).reverse()) close();
  vi.unstubAllEnvs();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'telos-commit-fence-'));
  closes.push(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    canonical: join(root, 'canonical.db'),
    events: join(root, '.mitzo/events.db'),
    tasks: join(root, '.mitzo/tasks.db'),
  };
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('TELOS_DB_PATH', files.canonical);
  createFreshTelosDatabaseFiles(files);
  const seed = new Database(files.canonical);
  seed.pragma('journal_mode=WAL');
  seed.exec(
    readFileSync(new URL('./fixtures/telos-canonical-3077b7b4/fresh.sql', import.meta.url), 'utf8'),
  );
  seed
    .prepare(
      "INSERT INTO items(id,summary,profile,context_hints,first_seen,last_seen,created_at,updated_at) VALUES('leaf','Leaf','manual','{}',?,?,?,?)",
    )
    .run('now', 'now', 'now', 'now');
  seed.close();
  const events = new EventStore(files.events);
  closes.push(() => events.close());
  const tasks = new TaskStore(files.tasks);
  closes.push(() => tasks.close());
  const work = new TelosWorkStore(files.canonical, { ordinaryConversation: () => true });
  closes.push(() => work.close());
  const actor = { kind: 'operator' as const, id: 'private-component-operator' };
  const command = (operation: 'trash' | 'delete_permanently') => ({
    requestId: randomUUID(),
    itemId: 'leaf',
    operation,
    expectedRevision: work.read('leaf', actor).revision,
    ...(operation === 'delete_permanently'
      ? { confirmation: { itemId: 'leaf', phrase: 'DELETE PERMANENTLY' } }
      : {}),
  });
  work.executeLifecycle(command('trash'), actor);
  return {
    files,
    events,
    tasks,
    work,
    actor,
    command,
    db: (work as unknown as { db: Database.Database }).db,
  };
}
function independentWriter(path: string) {
  return spawnSync(
    process.execPath,
    [
      '-e',
      `const Database=require(process.argv[1]);const db=new Database(process.argv[2],{timeout:0});try{db.exec('BEGIN IMMEDIATE;ROLLBACK');}catch(e){process.stdout.write(String(e.code));process.exitCode=23;}finally{db.close();}`,
      sqlite,
      path,
    ],
    { encoding: 'utf8', timeout: 5000, env: process.env },
  );
}
it('retains all actual writers after the callback expires and through the original receipt commit', () => {
  const f = fixture();
  let observed = 0;
  f.db.function('observe_retained_writers', () => {
    observed++;
    expect(() => f.work.assertLifecycleDeletionWriter('leaf', f.files.canonical)).toThrow();
    for (const path of Object.values(f.files)) {
      const other = independentWriter(path);
      expect(other.status).toBe(23);
      expect(other.stdout).toBe('SQLITE_BUSY');
    }
    return 1;
  });
  f.db.exec(
    "CREATE TRIGGER observe_delete_commit BEFORE INSERT ON telos_work_lifecycle_commands WHEN json_extract(NEW.receipt,'$.operation')='delete_permanently' BEGIN SELECT observe_retained_writers();END",
  );
  const result = f.work.executeLifecycle(f.command('delete_permanently'), f.actor, (id) =>
    f.work.retainLifecycleDeletionFence(id, f.files.canonical, f.events, f.tasks, () => {}),
  );
  expect(result.operation).toBe('delete_permanently');
  expect(observed).toBe(1);
  expect(f.db.prepare("SELECT id FROM items WHERE id='leaf'").get()).toBeUndefined();
  for (const path of Object.values(f.files)) expect(independentWriter(path).status).toBe(0);
});
it('rechecks complete references before commit and rolls back the canonical deletion', () => {
  const f = fixture();
  f.db.function('retain_late_reference', () => {
    const db = f.tasks.getDatabase();
    db.pragma('defer_foreign_keys=ON');
    db.prepare('INSERT INTO task_telos_execution_bindings VALUES(?,?,?,?,?,?,?,?)').run(
      'missing-task',
      'attempt',
      'leaf',
      'lead',
      'worker',
      'snapshot',
      'a'.repeat(64),
      1,
    );
    return 1;
  });
  f.db.exec(
    "CREATE TRIGGER late_reference BEFORE INSERT ON telos_work_lifecycle_commands WHEN json_extract(NEW.receipt,'$.operation')='delete_permanently' BEGIN SELECT retain_late_reference();END",
  );
  expect(() =>
    f.work.executeLifecycle(f.command('delete_permanently'), f.actor, (id) =>
      f.work.retainLifecycleDeletionFence(id, f.files.canonical, f.events, f.tasks, () => {}),
    ),
  ).toThrow(/reference/);
  expect(f.work.readLifecycle('leaf', f.actor).disposition).toBe('trashed');
  expect(f.tasks.getDatabase().inTransaction).toBe(false);
});
it('requires its original callback frame and refuses borrowed/reentrant authority', () => {
  const f = fixture();
  expect(() =>
    f.work.retainLifecycleDeletionFence('leaf', f.files.canonical, f.events, f.tasks, () => {}),
  ).toThrow();
  f.tasks.getDatabase().exec('BEGIN IMMEDIATE');
  expect(() =>
    f.work.executeLifecycle(f.command('delete_permanently'), f.actor, (id) =>
      f.work.retainLifecycleDeletionFence(id, f.files.canonical, f.events, f.tasks, () => {}),
    ),
  ).toThrow();
  expect(f.tasks.getDatabase().inTransaction).toBe(true);
  f.tasks.getDatabase().exec('ROLLBACK');
  expect(f.work.readLifecycle('leaf', f.actor).disposition).toBe('trashed');
});

it('refuses a replacement canonical transaction after the original callback writer was committed', () => {
  const f = fixture();
  expect(() =>
    f.work.executeLifecycle(f.command('delete_permanently'), f.actor, (id) => {
      f.work.retainLifecycleDeletionFence(id, f.files.canonical, f.events, f.tasks, () => {});
      f.db.exec('COMMIT;BEGIN IMMEDIATE');
    }),
  ).toThrow();
  expect(f.work.readLifecycle('leaf', f.actor).disposition).toBe('trashed');
});

it('retains the committed receipt when reference cleanup fails after canonical commit', () => {
  const f = fixture();
  const db = f.tasks.getDatabase();
  const realExec = db.exec.bind(db);
  const exec = vi.spyOn(db, 'exec').mockImplementation((sql) => {
    if (sql === 'ROLLBACK') throw new Error('Injected actual reference rollback cleanup failure');
    return realExec(sql);
  });
  const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
  try {
    const input = f.command('delete_permanently');
    const receipt = f.work.executeLifecycle(input, f.actor, (id) =>
      f.work.retainLifecycleDeletionFence(id, f.files.canonical, f.events, f.tasks, () => {}),
    );
    expect(receipt.operation).toBe('delete_permanently');
    expect(f.db.prepare("SELECT id FROM items WHERE id='leaf'").get()).toBeUndefined();
    expect(
      JSON.parse(
        (
          f.db
            .prepare('SELECT receipt FROM telos_work_lifecycle_commands WHERE request_id=?')
            .get(input.requestId) as { receipt: string }
        ).receipt,
      ),
    ).toEqual(receipt);
    expect(warning).toHaveBeenCalledOnce();
  } finally {
    exec.mockRestore();
    warning.mockRestore();
    if (db.inTransaction) realExec('ROLLBACK');
  }
});
