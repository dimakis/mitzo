import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  MAX_SESSION_DOCUMENT_BYTES,
  type SessionDocument,
  type SessionDocumentWrite,
} from './session-document.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const columns =
  'id,session_id AS sessionId,title,filename,revision,sha256,size,source_key AS sourceKey,source_path AS sourcePath,created_at AS createdAt';
const filename = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !/[\\/\x00-\x1f\x7f]/.test(value) && value !== '.' && value !== '..');
const write = z.object({
  requestId: z.string().min(1).max(200),
  intent: z.string().min(1).max(8192),
  title: z.string().trim().min(1).max(200),
  filename,
  sourceKey: z.string().min(1).max(8192),
  sourcePath: z.string().max(4096).nullable(),
});

/** Shares the event owner's connection, transaction, backup and retention lifecycle. */
export class SessionDocumentStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS session_document_revisions (
      id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
      title TEXT NOT NULL,filename TEXT NOT NULL,revision INTEGER NOT NULL,sha256 TEXT NOT NULL,
      size INTEGER NOT NULL,source_key TEXT NOT NULL,source_path TEXT,created_at INTEGER NOT NULL,bytes BLOB NOT NULL,
      PRIMARY KEY(session_id,id,revision));
      CREATE TABLE IF NOT EXISTS session_document_requests (
        session_id TEXT NOT NULL,request_id TEXT NOT NULL,intent TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,
        PRIMARY KEY(session_id,request_id),
        FOREIGN KEY(session_id,id,revision) REFERENCES session_document_revisions(session_id,id,revision) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS idx_session_documents ON session_document_revisions(session_id,created_at);`);
  }
  receipt(sessionId: string, requestId: string, intent: string): SessionDocument | null {
    const row = this.db
      .prepare(
        'SELECT intent,id,revision FROM session_document_requests WHERE session_id=? AND request_id=?',
      )
      .get(sessionId, requestId) as { intent: string; id: string; revision: number } | undefined;
    if (!row) return null;
    if (row.intent !== intent) throw new Error('Document save request conflicts');
    return this.metadata(sessionId, row.id, row.revision);
  }
  keep(sessionId: string, input: SessionDocumentWrite): SessionDocument {
    const value = write.parse(input);
    if (!Buffer.isBuffer(input.bytes) || input.bytes.length > MAX_SESSION_DOCUMENT_BYTES)
      throw new Error('Document exceeds 5 MB');
    const bytes = Buffer.from(input.bytes);
    return this.db
      .transaction(() => {
        const prior = this.receipt(sessionId, value.requestId, value.intent);
        if (prior) return prior;
        const id = hash(JSON.stringify([sessionId, value.sourceKey])).slice(0, 32);
        const previous = this.versions(sessionId, id)[0];
        const sha256 = hash(bytes);
        let saved = previous;
        if (
          !previous ||
          previous.sha256 !== sha256 ||
          previous.title !== value.title ||
          previous.filename !== value.filename ||
          previous.sourcePath !== value.sourcePath
        ) {
          const revision = (previous?.revision ?? 0) + 1;
          this.db
            .prepare('INSERT INTO session_document_revisions VALUES (?,?,?,?,?,?,?,?,?,?,?)')
            .run(
              id,
              sessionId,
              value.title,
              value.filename,
              revision,
              sha256,
              bytes.length,
              value.sourceKey,
              value.sourcePath,
              Date.now(),
              bytes,
            );
          saved = this.metadata(sessionId, id, revision);
        }
        this.db
          .prepare('INSERT INTO session_document_requests VALUES (?,?,?,?,?)')
          .run(sessionId, value.requestId, value.intent, id, saved.revision);
        return saved;
      })
      .immediate();
  }
  list(sessionId: string): SessionDocument[] {
    return this.db
      .prepare(
        `SELECT ${columns} FROM session_document_revisions d WHERE session_id=?
      AND revision=(SELECT MAX(revision) FROM session_document_revisions WHERE session_id=d.session_id AND id=d.id)
      ORDER BY created_at DESC,id LIMIT 100`,
      )
      .all(sessionId) as SessionDocument[];
  }
  versions(sessionId: string, id: string, before = Number.MAX_SAFE_INTEGER): SessionDocument[] {
    return this.db
      .prepare(
        `SELECT ${columns} FROM session_document_revisions WHERE session_id=? AND id=? AND revision<? ORDER BY revision DESC LIMIT 50`,
      )
      .all(sessionId, id, before) as SessionDocument[];
  }
  private metadata(sessionId: string, id: string, revision: number): SessionDocument {
    const row = this.db
      .prepare(
        `SELECT ${columns} FROM session_document_revisions WHERE session_id=? AND id=? AND revision=?`,
      )
      .get(sessionId, id, revision) as SessionDocument | undefined;
    if (!row) throw new Error('Saved document not found');
    return row;
  }
  read(sessionId: string, id: string, revision: number) {
    const metadata = this.metadata(sessionId, id, revision);
    const row = this.db
      .prepare(
        `SELECT CASE WHEN typeof(bytes)='blob' AND size=length(bytes) AND size<=? THEN bytes END AS bytes
      FROM session_document_revisions WHERE session_id=? AND id=? AND revision=?`,
      )
      .get(MAX_SESSION_DOCUMENT_BYTES, sessionId, id, revision) as { bytes: Buffer | null };
    if (!Buffer.isBuffer(row.bytes) || hash(row.bytes) !== metadata.sha256)
      throw new Error('Saved document bytes unavailable');
    return { ...metadata, bytes: row.bytes };
  }
}
