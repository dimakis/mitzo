import Database from 'better-sqlite3';
import { parentPort, workerData } from 'node:worker_threads';
import type { SearchEvent, SearchSession, SearchHit } from './session-search-index.js';
import { sessionSearchTerms, searchLike } from './session-search-query.js';

// Only public text and public metadata enter this disposable, private index.
const db = new Database(workerData.database);
db.exec(`
  PRAGMA journal_mode=OFF;
  PRAGMA synchronous=OFF;
  PRAGMA cache_size=-4096;
  PRAGMA temp_store=MEMORY;
  CREATE VIRTUAL TABLE documents USING fts5(text, session_id UNINDEXED,
    message_id UNINDEXED, matched_at UNINDEXED, seq UNINDEXED, key UNINDEXED,
    tokenize='trigram');
  CREATE TABLE blocks(key TEXT PRIMARY KEY, type TEXT, rowid INTEGER);
  CREATE TABLE sessions(session_id TEXT PRIMARY KEY, summary TEXT, updated_at INTEGER,
    model TEXT, provider TEXT, account TEXT, project TEXT);
`);
const insert = db.prepare(
  'INSERT INTO documents(text,session_id,message_id,matched_at,seq,key) VALUES(?,?,?,?,?,?)',
);
const block = db.prepare('SELECT type,rowid FROM blocks WHERE key=?');
const saveBlock = db.prepare(
  'INSERT INTO blocks VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET type=excluded.type, rowid=excluded.rowid',
);
const update = db.prepare('UPDATE documents SET text=text || ?,matched_at=?,seq=? WHERE rowid=?');
const session = db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?)');

function append(events: SearchEvent[]): void {
  db.transaction(() => {
    // One update per block per bounded source page, rather than per streaming token.
    const pending = new Map<
      string,
      { text: string; event: SearchEvent; messageId: string; rowid?: number }
    >();
    for (const event of events) {
      if (!['user_message', 'block_start', 'block_delta'].includes(event.type)) continue;
      const payload = JSON.parse(event.payload);
      const messageId = typeof payload.messageId === 'string' ? payload.messageId : '';
      const key = JSON.stringify([event.session_id, messageId, payload.blockId ?? event.seq]);
      if (event.type === 'block_start') {
        saveBlock.run(key, payload.blockType ?? 'unknown', null);
        continue;
      }
      if (event.type === 'user_message') {
        if (typeof payload.text === 'string')
          insert.run(
            payload.text,
            event.session_id,
            messageId || null,
            event.created_at,
            event.seq,
            null,
          );
        continue;
      }
      const known = block.get(key) as { type: string; rowid: number | null } | undefined;
      const type = known?.type ?? payload.blockType;
      if (
        (type && type !== 'text') ||
        (payload.blockType && payload.blockType !== 'text') ||
        typeof payload.delta !== 'string'
      )
        continue;
      // A block ID alone can be reused by later legacy messages. Retain its
      // type boundary, but join text only with both stable message/block IDs.
      const identified = messageId !== '' && typeof payload.blockId === 'string';
      const documentKey = identified ? key : JSON.stringify([event.session_id, event.seq]);
      const current = pending.get(documentKey);
      if (current) {
        current.text += payload.delta;
        current.event = event;
      } else
        pending.set(documentKey, {
          text: payload.delta,
          event,
          messageId,
          rowid: identified ? (known?.rowid ?? undefined) : undefined,
        });
    }
    for (const [key, item] of pending) {
      let rowid = item.rowid;
      if (rowid) update.run(item.text, item.event.created_at, item.event.seq, rowid);
      else
        rowid = Number(
          insert.run(
            item.text,
            item.event.session_id,
            item.messageId || null,
            item.event.created_at,
            item.event.seq,
            key,
          ).lastInsertRowid,
        );
      saveBlock.run(key, 'text', rowid);
    }
  })();
}

function search(query: string, limit: number, sessions: SearchSession[]): SearchHit[] {
  const terms = sessionSearchTerms(query);
  if (!terms.length) return [];
  db.transaction(() => {
    db.exec('DELETE FROM sessions');
    for (const row of sessions)
      session.run(
        row.session_id,
        row.summary,
        row.updated_at,
        row.model ?? null,
        row.provider ?? null,
        row.account ?? null,
        row.project ?? null,
      );
  })();
  const parameters: (string | number)[] = [];
  const parts: string[] = [];
  for (const [index, term] of terms.entries()) {
    const indexed = [...term].length >= 3 && !term.includes('\0');
    parts.push(`SELECT d.session_id,${index} AS term,'messages' AS field,5 AS weight,
      d.rowid AS document FROM documents d JOIN sessions s ON s.session_id=d.session_id
      WHERE ${indexed ? 'documents MATCH ? AND' : ''} d.text LIKE ? ESCAPE '\\'`);
    if (indexed) parameters.push(`"${term.replaceAll('"', '""')}"`);
    parameters.push(searchLike(term));
    for (const [field, column, weight] of [
      ['title', 'summary', 40],
      ['model', 'model', 30],
      ['provider', 'provider', 30],
      ['account', 'account', 30],
      ['project', 'project', 20],
    ] as const) {
      parts.push(`SELECT session_id,${index},'${field}',${weight},NULL FROM sessions
        WHERE ${column} LIKE ? ESCAPE '\\'`);
      parameters.push(searchLike(term));
    }
  }
  parameters.push(terms.length, terms.join(' '), limit);
  const rows = db
    .prepare(
      `
    WITH hits AS (${parts.join(' UNION ALL ')}),
    term_scores AS (
      SELECT session_id,term,MAX(weight) AS weight FROM hits GROUP BY session_id,term
    ), eligible AS (
      SELECT session_id,SUM(weight) AS score FROM term_scores
      GROUP BY session_id HAVING COUNT(*)=?
    ), evidence AS (
      SELECT session_id,document,COUNT(DISTINCT term) AS coverage
      FROM hits WHERE document IS NOT NULL GROUP BY session_id,document
    )
    SELECT s.*, (SELECT group_concat(DISTINCT field) FROM hits h
      WHERE h.session_id=s.session_id) AS matched_fields,
      d.text AS matched_text,d.message_id,d.matched_at,d.seq
    FROM eligible e JOIN sessions s ON s.session_id=e.session_id
    LEFT JOIN documents d ON d.rowid=(
      SELECT v.document FROM evidence v JOIN documents doc ON doc.rowid=v.document
      WHERE v.session_id=s.session_id ORDER BY v.coverage DESC,doc.matched_at DESC,doc.seq DESC LIMIT 1
    )
    ORDER BY (e.score + CASE WHEN s.summary=? COLLATE NOCASE THEN 100 ELSE 0 END) DESC,
      COALESCE(d.matched_at,s.updated_at) DESC,COALESCE(d.seq,0) DESC,s.session_id
    LIMIT ?
  `,
    )
    .all(...parameters) as Array<
    SearchSession & {
      matched_fields: string;
      matched_text: string | null;
      message_id: string | null;
      matched_at: number | null;
    }
  >;
  return rows.map((row) => ({
    ...row,
    payload: JSON.stringify({
      text:
        row.matched_text ??
        [
          row.summary,
          row.model && `Model: ${row.model}`,
          row.account && `Account: ${row.account}`,
          row.provider && `Provider: ${row.provider}`,
          row.project && `Project: ${row.project}`,
        ]
          .filter(Boolean)
          .join(' · '),
    }),
    matched_at: row.matched_at ?? row.updated_at,
    matched_fields: row.matched_fields.split(',') as SearchHit['matched_fields'],
    message_id: row.message_id ?? undefined,
  }));
}

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
        append(message.events!);
        parentPort!.postMessage({ id: message.id });
      } else
        parentPort!.postMessage({
          id: message.id,
          result: search(message.query!, message.limit!, message.sessions!),
        });
    } catch {
      parentPort!.postMessage({ id: message.id, failed: true });
    }
  },
);
