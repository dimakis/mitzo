import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const commit = /^[a-f0-9]{40}$/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const reasons = new Set([
  'host-resources',
  'stage-unavailable',
  'source-superseded',
  'capability-unavailable',
  'deployment-uncertain',
  'test-cleanup-uncertain',
  'controller-lost',
]);
function validateRequest(r) {
  if (
    !r ||
    Object.keys(r).sort().join() !== 'acceptedCommit,id,pr,suite,taskId' ||
    !identifier.test(r.id) ||
    !identifier.test(r.taskId) ||
    !Number.isSafeInteger(r.pr) ||
    r.pr < 1 ||
    !commit.test(r.acceptedCommit) ||
    r.suite !== 'http-readiness'
  )
    throw Error('Exact accepted source and supported staging suite required');
  return { id: r.id, taskId: r.taskId, pr: r.pr, acceptedCommit: r.acceptedCommit, suite: r.suite };
}
/** Separate from deployment.lock: this reservation persists through testing and
 * across controller loss. Expiry is never permission to replace native custody. */
export class StagingPipelineStore {
  constructor(path, { clock = Date.now, readOnly = false } = {}) {
    path = resolve(path);
    const parent = lstatSync(dirname(path));
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.uid !== process.getuid() ||
      parent.mode & 0o077 ||
      realpathSync(dirname(path)) !== dirname(path)
    )
      throw Error('Private pipeline directory required');
    if (!readOnly) {
      try {
        const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        closeSync(fd);
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const s = fstatSync(fd);
      if (!s.isFile() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o600 || s.nlink !== 1)
        throw Error('Private pipeline database required');
    } finally {
      closeSync(fd);
    }
    this.clock = clock;
    this.db = new DatabaseSync(path, { readOnly });
    if (readOnly) return;
    this.db
      .exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA max_page_count=4096;
      CREATE TABLE IF NOT EXISTS requests(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,payload TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,reason TEXT,result TEXT);
      CREATE TABLE IF NOT EXISTS reservation(singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch INTEGER NOT NULL,state TEXT NOT NULL,request_id TEXT,owner TEXT,nonce TEXT,deadline INTEGER,dispatched INTEGER NOT NULL DEFAULT 0,source_commit TEXT);
      INSERT OR IGNORE INTO reservation(singleton,epoch,state) VALUES(1,0,'idle');`);
  }
  close() {
    this.db.close();
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  enqueue(input) {
    const r = validateRequest(input),
      payload = JSON.stringify(r),
      fingerprint = createHash('sha256').update(payload).digest('hex');
    return this.transaction(() => {
      const old = this.db.prepare('SELECT fingerprint FROM requests WHERE id=?').get(r.id);
      if (old) {
        if (old.fingerprint !== fingerprint) throw Error('Request identity changed');
        return r.id;
      }
      if (
        this.db
          .prepare(
            "SELECT count(*) AS n FROM requests WHERE state IN ('queued','active','quarantined')",
          )
          .get().n >= 100
      )
        throw Error('Staging queue capacity reached');
      this.db
        .prepare("INSERT INTO requests(id,payload,fingerprint,state) VALUES(?,?,?,'queued')")
        .run(r.id, payload, fingerprint);
      return r.id;
    });
  }
  status() {
    const row = this.db.prepare('SELECT * FROM reservation WHERE singleton=1').get();
    return {
      reservation: {
        state: row.state,
        epoch: row.epoch,
        requestId: row.request_id,
        owner: row.owner,
        deadline: row.deadline,
        dispatched: Boolean(row.dispatched),
      },
      requests: this.db
        .prepare(
          `SELECT payload,state,reason,result FROM requests
          ORDER BY CASE WHEN state IN ('active','quarantined') THEN 0 WHEN state='queued' THEN 1 ELSE 2 END,
            CASE WHEN state IN ('queued','active','quarantined') THEN sequence ELSE -sequence END LIMIT 200`,
        )
        .all()
        .map((r) => ({
          ...JSON.parse(r.payload),
          state: r.state,
          reason: r.reason,
          result: r.result ? JSON.parse(r.result) : null,
        })),
    };
  }
  receipt(id) {
    if (!identifier.test(id)) throw Error('Exact request identifier required');
    const row = this.db
      .prepare('SELECT payload,state,reason,result FROM requests WHERE id=?')
      .get(id);
    if (!row) return { version: 1, requestId: id, state: 'missing' };
    const { pr, taskId, acceptedCommit, suite } = JSON.parse(row.payload);
    return {
      version: 1,
      requestId: id,
      pr,
      taskId,
      acceptedCommit,
      suite,
      state: row.state,
      reason: row.reason,
      result: row.result ? JSON.parse(row.result) : null,
    };
  }
  claim(owner) {
    if (!identifier.test(owner)) throw Error('Controller identity required');
    return this.transaction(() => {
      const r = this.db.prepare('SELECT * FROM reservation WHERE singleton=1').get();
      if (r.state !== 'idle')
        return {
          granted: false,
          reason:
            r.state === 'quarantined'
              ? 'environment-quarantined'
              : this.clock() > r.deadline
                ? 'reconciliation-required'
                : 'staging-busy',
        };
      const next = this.db
        .prepare("SELECT id,payload FROM requests WHERE state='queued' ORDER BY sequence LIMIT 1")
        .get();
      if (!next) return { granted: false, reason: 'queue-empty' };
      const token = { epoch: r.epoch + 1, requestId: next.id, owner, nonce: randomUUID() };
      this.db
        .prepare(
          "UPDATE reservation SET state='active',epoch=?,request_id=?,owner=?,nonce=?,deadline=?,dispatched=0,source_commit=NULL WHERE singleton=1",
        )
        .run(token.epoch, token.requestId, owner, token.nonce, this.clock() + 600000);
      this.db.prepare("UPDATE requests SET state='active',reason=NULL WHERE id=?").run(next.id);
      return { granted: true, token, request: JSON.parse(next.payload) };
    });
  }
  assertToken(t) {
    const r = this.db.prepare('SELECT * FROM reservation WHERE singleton=1').get();
    if (
      !t ||
      r.state !== 'active' ||
      r.epoch !== t.epoch ||
      r.request_id !== t.requestId ||
      r.owner !== t.owner ||
      r.nonce !== t.nonce
    )
      throw Error('Staging reservation changed');
    return r;
  }
  markDispatched(t) {
    this.transaction(() => {
      this.assertToken(t);
      this.db.prepare('UPDATE reservation SET dispatched=1 WHERE singleton=1').run();
    });
  }
  defer(t, reason) {
    if (!reasons.has(reason)) throw Error('Bounded reason required');
    this.transaction(() => {
      if (this.assertToken(t).dispatched)
        throw Error('Cannot defer dispatched staging work before terminal reconciliation');
      this.db
        .prepare("UPDATE requests SET state='queued',reason=? WHERE id=?")
        .run(reason, t.requestId);
      this.release();
    });
  }
  release() {
    this.db
      .prepare(
        "UPDATE reservation SET state='idle',request_id=NULL,owner=NULL,nonce=NULL,deadline=NULL,dispatched=0,source_commit=NULL WHERE singleton=1",
      )
      .run();
  }
  settleDeployment(t, sourceCommit) {
    this.transaction(() => {
      const r = this.assertToken(t);
      if (r.source_commit !== sourceCommit || !r.dispatched)
        throw Error('Verified deployed source and original reservation required');
      this.db.prepare('UPDATE reservation SET dispatched=0 WHERE singleton=1').run();
    });
  }
  bindBaseline(t, sourceCommit) {
    if (!commit.test(sourceCommit)) throw Error('Exact test source required');
    this.transaction(() => {
      if (this.assertToken(t).dispatched) throw Error('Cannot change dispatched test source');
      this.db.prepare('UPDATE reservation SET source_commit=? WHERE singleton=1').run(sourceCommit);
    });
  }
  finish(t, result) {
    this.transaction(() => {
      const reservation = this.assertToken(t);
      const r = JSON.parse(
        this.db.prepare('SELECT payload FROM requests WHERE id=?').get(t.requestId).payload,
      );
      if (
        !result ||
        !['passed', 'failed'].includes(result.outcome) ||
        result.sourceCommit !== (reservation.source_commit ?? r.acceptedCommit)
      )
        throw Error('Test source does not match request');
      if (result.cleanupConfirmed !== true) throw Error('Confirmed test cleanup required');
      const receipt = {
        acceptedCommit: r.acceptedCommit,
        outcome: result.outcome,
        sourceCommit: result.sourceCommit,
        epoch: t.epoch,
        suite: r.suite,
        cleanupConfirmed: true,
        completedAt: this.clock(),
      };
      this.db
        .prepare('UPDATE requests SET state=?,result=? WHERE id=?')
        .run(result.outcome, JSON.stringify(receipt), r.id);
      this.release();
    });
  }
  quarantine(t, reason) {
    if (!reasons.has(reason)) throw Error('Bounded reason required');
    this.transaction(() => {
      this.assertToken(t);
      this.db.prepare("UPDATE reservation SET state='quarantined' WHERE singleton=1").run();
      this.db
        .prepare("UPDATE requests SET state='quarantined',reason=? WHERE id=?")
        .run(reason, t.requestId);
    });
  }
  cancel(id) {
    this.transaction(() => {
      const r = this.db.prepare('SELECT state FROM requests WHERE id=?').get(id);
      if (!r) throw Error('Request unavailable');
      if (r.state !== 'queued') throw Error('Cannot cancel active or completed staging work');
      this.db.prepare("UPDATE requests SET state='cancelled',reason=NULL WHERE id=?").run(id);
    });
  }
}
