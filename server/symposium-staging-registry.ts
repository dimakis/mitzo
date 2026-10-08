import Database from 'better-sqlite3';
import { lstatSync, realpathSync, openSync, closeSync, constants, fstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readCustodianRetirementReceipt } from './symposium-custodian-retirement.js';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_. -]{0,199}$/);
const Registration = z.strictObject({
  ownerChat: identifier,
  purpose: identifier,
  retentionReason: identifier,
  reviewAfter: z.number().int().positive(),
  planDirectory: z.string().refine(isAbsolute),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  buildSha256: z.string().regex(/^[a-f0-9]{64}$/),
  configSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type StagingRegistration = z.infer<typeof Registration>;
export interface StagingRecord extends StagingRegistration {
  launchId: string;
  createdAt: number;
  state: 'launch_uncertain' | 'active' | 'retiring' | 'retirement_uncertain' | 'retired';
  instanceId: string | null;
  controllerGeneration: number;
  retirementStateParent: string | null;
  completedAt: number | null;
}
/** Operator ledger only. No record confers native custody, cleanup, or adoption.
 * Mutators are fresh process-local launcher closures; reopening exposes no adopt API. */
export function openStagingRegistry(directory: string, capacity: number) {
  if (!isAbsolute(directory) || realpathSync(directory) !== directory)
    throw Error('Private registry required');
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || parent.mode & 0o077)
    throw Error('Private registry required');
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 20)
    throw Error('Invalid capacity policy');
  const path = join(directory, 'staging.db');
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1
    )
      throw Error('Private registry required');
  } finally {
    closeSync(fd);
  }
  const db = new Database(path);
  try {
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = FULL');
    db.exec(`CREATE TABLE IF NOT EXISTS policy (id INTEGER PRIMARY KEY CHECK(id=1), capacity INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS launches (
        launchId TEXT PRIMARY KEY, planDirectory TEXT UNIQUE NOT NULL, ownerChat TEXT NOT NULL,
        purpose TEXT NOT NULL, retentionReason TEXT NOT NULL, reviewAfter INTEGER NOT NULL,
        sourceCommit TEXT NOT NULL, buildSha256 TEXT NOT NULL, configSha256 TEXT NOT NULL,
        createdAt INTEGER NOT NULL, state TEXT NOT NULL, instanceId TEXT,
        controllerGeneration INTEGER NOT NULL DEFAULT 0, retirementStateParent TEXT, completedAt INTEGER);`);
    db.prepare('INSERT OR IGNORE INTO policy VALUES (1, ?)').run(capacity);
    if (
      (db.prepare('SELECT capacity FROM policy WHERE id=1').get() as { capacity: number })
        .capacity !== capacity
    )
      throw Error('Registry capacity policy cannot change at launch');
  } catch (error) {
    db.close();
    throw error;
  }
  const list = () =>
    db.prepare('SELECT * FROM launches ORDER BY createdAt, launchId').all() as StagingRecord[];
  return {
    list,
    close: () => db.close(),
    reserve(value: StagingRegistration, now = Date.now()) {
      const input = Registration.parse(value);
      if (input.reviewAfter <= now || input.reviewAfter > now + 7 * 86400_000)
        throw Error('Retention review deadline must be within seven days');
      const launchId = randomUUID();
      db.transaction(() => {
        const retained = list().filter((r) => r.state !== 'retired');
        if (retained.some((r) => r.reviewAfter <= now))
          throw Error('Review stale staging retention before launching');
        if (retained.length >= capacity) throw Error('Staging capacity exhausted');
        db.prepare(
          `INSERT INTO launches
          (launchId,planDirectory,ownerChat,purpose,retentionReason,reviewAfter,sourceCommit,buildSha256,configSha256,createdAt,state)
          VALUES (@launchId,@planDirectory,@ownerChat,@purpose,@retentionReason,@reviewAfter,@sourceCommit,@buildSha256,@configSha256,@now,'launch_uncertain')`,
        ).run({ ...input, launchId, now });
      }).immediate();
      let failed = false;
      const update = (work: (r: StagingRecord) => void) => {
        if (failed) throw Error('Staging recorder unavailable');
        try {
          db.transaction(() => {
            const r = db
              .prepare('SELECT * FROM launches WHERE launchId=?')
              .get(launchId) as StagingRecord;
            if (!r || r.state === 'retired') throw Error('Staging recorder is terminal');
            work(r);
          }).immediate();
        } catch (error) {
          // A validation refusal does not poison later uncertainty recording;
          // SQLite failures fence further writes rather than silently retrying.
          if (error instanceof Database.SqliteError) failed = true;
          throw error;
        }
      };
      return {
        launchId,
        controller(identity: { instanceId: string; epoch: number }) {
          update((r) => {
            if (
              !['launch_uncertain', 'active'].includes(r.state) ||
              !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(identity.instanceId) ||
              !Number.isSafeInteger(identity.epoch) ||
              identity.epoch <= r.controllerGeneration ||
              (r.instanceId !== null && r.instanceId !== identity.instanceId)
            )
              throw Error('Staging original identity changed');
            db.prepare(
              "UPDATE launches SET state='active',instanceId=?,controllerGeneration=? WHERE launchId=?",
            ).run(identity.instanceId, identity.epoch, launchId);
          });
        },
        retiring(identity?: Readonly<{ instanceId: string; controllerGeneration: number }>) {
          update((r) => {
            if (identity) {
              // Only the fresh original launcher closure receives this snapshot from
              // its live custodian. Reconcile attach-before-hello; never adopt from a receipt.
              if (
                !['launch_uncertain', 'active'].includes(r.state) ||
                !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(identity.instanceId) ||
                !Number.isSafeInteger(identity.controllerGeneration) ||
                identity.controllerGeneration < 1 ||
                identity.controllerGeneration < r.controllerGeneration ||
                (r.instanceId !== null && r.instanceId !== identity.instanceId)
              )
                throw Error('Staging retirement identity changed');
              db.prepare(
                "UPDATE launches SET state='retiring',instanceId=?,controllerGeneration=? WHERE launchId=?",
              ).run(identity.instanceId, identity.controllerGeneration, launchId);
            } else {
              if (r.state !== 'active') throw Error('Staging retirement unavailable');
              db.prepare("UPDATE launches SET state='retiring' WHERE launchId=?").run(launchId);
            }
          });
        },
        uncertain() {
          update(() =>
            db
              .prepare("UPDATE launches SET state='retirement_uncertain' WHERE launchId=?")
              .run(launchId),
          );
        },
        retired(stateParent: string) {
          update((r) => {
            const receipt = readCustodianRetirementReceipt(stateParent);
            if (!receipt) throw Error('Original retirement receipt required');
            if (
              r.state !== 'retiring' ||
              receipt.instanceId !== r.instanceId ||
              receipt.controllerGeneration !== r.controllerGeneration ||
              receipt.completedAt < r.createdAt
            )
              throw Error('Retirement receipt identity mismatch');
            db.prepare(
              "UPDATE launches SET state='retired',retirementStateParent=?,completedAt=? WHERE launchId=?",
            ).run(stateParent, receipt.completedAt, launchId);
          });
        },
      };
    },
  };
}
