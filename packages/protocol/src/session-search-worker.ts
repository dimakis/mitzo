import Database from 'better-sqlite3';
import { parentPort, workerData } from 'node:worker_threads';
import type { SearchEvent, SearchSession } from './session-search-index.js';

// No retained file or credentials enter this worker. Its private disposable
// index is disk-backed so history size cannot become server heap consumption.
const db = new Database(workerData.database);
db.exec(`
  PRAGMA journal_mode=OFF;
  PRAGMA synchronous=OFF;
  PRAGMA cache_size=-4096;
  -- Temporary query data must not escape the protected index directory into
  -- SQLite's process-wide OS temporary location. Keep query scratch in memory.
  PRAGMA temp_store=MEMORY;
  CREATE VIRTUAL TABLE documents USING fts5(text, delta, session_id UNINDEXED,
    matched_at UNINDEXED, seq UNINDEXED, tokenize='trigram');
  CREATE TABLE sessions(session_id TEXT PRIMARY KEY, summary TEXT, updated_at INTEGER, conversation_id TEXT, conversation_summary TEXT);
`);
const append = db.prepare(
  'INSERT INTO documents(rowid,text,delta,session_id,matched_at,seq) VALUES(?,?,?,?,?,?)',
);
const session = db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)');
parentPort!.on(
  'message',
  (message: {
    id: number;
    type: 'append' | 'search';
    events?: SearchEvent[];
    query?: string;
    limit?: number;
    sessions?: SearchSession[];
  }) => {
    try {
      if (message.type === 'append') {
        db.transaction(() => {
          for (const event of message.events!) {
            if (!['user_message', 'block_delta'].includes(event.type)) continue;
            const payload = JSON.parse(event.payload);
            const text = typeof payload.text === 'string' ? payload.text : null;
            const delta = typeof payload.delta === 'string' ? payload.delta : null;
            if (text !== null || delta !== null)
              append.run(event.seq, text, delta, event.session_id, event.created_at, event.seq);
          }
        })();
        parentPort!.postMessage({ id: message.id });
        return;
      }
      db.transaction(() => {
        db.exec('DELETE FROM sessions');
        for (const row of message.sessions!)
          session.run(
            row.session_id,
            row.summary,
            row.updated_at,
            row.conversation_id ?? row.session_id,
            row.conversation_summary ?? row.summary,
          );
      })();
      const query = message.query!;
      const pattern = `%${query.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
      // Trigram MATCH narrows candidates; LIKE retains the existing literal,
      // ASCII case and substring semantics. Short searches stay off the server.
      const indexed = [...query].length >= 3 && !query.includes('\0');
      const rows = db
        .prepare(
          `WITH candidates AS (
      SELECT s.conversation_id AS session_id, s.conversation_summary AS summary, d.session_id AS matched_session_id, json_object('text',d.text,'delta',d.delta) AS payload,
        d.matched_at, d.seq AS matched_seq, s.updated_at, 1 AS content_match
      FROM documents d JOIN sessions s ON s.session_id=d.session_id
      WHERE ${indexed ? 'documents MATCH ? AND' : ''}
        (d.text LIKE ? ESCAPE '\\' OR d.delta LIKE ? ESCAPE '\\')
      UNION ALL SELECT conversation_id, conversation_summary, session_id, json_object('text',summary), updated_at, 0,
        updated_at, 0 FROM sessions WHERE summary LIKE ? ESCAPE '\\'
    ), matches AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY session_id
        ORDER BY content_match DESC, matched_at DESC, matched_seq DESC) AS match_rank FROM candidates
    ) SELECT session_id, summary, matched_session_id, payload, matched_at, updated_at FROM matches
      WHERE match_rank=1 ORDER BY matched_at DESC, matched_seq DESC LIMIT ?`,
        )
        .all(
          ...(indexed ? [`"${query.replaceAll('"', '""')}"`] : []),
          pattern,
          pattern,
          pattern,
          message.limit,
        );
      parentPort!.postMessage({ id: message.id, result: rows });
    } catch {
      // Never return a partial index/query, payload text or an internal exception.
      parentPort!.postMessage({ id: message.id, failed: true });
    }
  },
);
