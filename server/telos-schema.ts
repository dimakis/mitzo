import type Database from 'better-sqlite3';

/** Compatible with canonical MGMT schema 3077b7b4. Additions are serialized;
 * existing records, extension tables and unknown columns are never rewritten. */
export function initializeTelosSchema(db: Database.Database) {
  // Bootstrap owns schema checks/upgrades. Ordinary owner opens never call this.
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY, summary TEXT NOT NULL, intent TEXT DEFAULT '', rationale TEXT DEFAULT '',
      acceptance_criteria TEXT DEFAULT '[]', idempotency_key TEXT, profile TEXT NOT NULL,
      cluster_id TEXT, urgency REAL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 5 CHECK(typeof(priority)='integer' AND priority BETWEEN 1 AND 10),
      categories TEXT NOT NULL DEFAULT '[]', starred INTEGER DEFAULT 0, status TEXT DEFAULT 'active',
      snoozed_until TEXT, context_hints TEXT DEFAULT '{}', first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, parent_id TEXT REFERENCES items(id) ON DELETE CASCADE, goal_id TEXT);
      CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,type TEXT NOT NULL,source_id TEXT NOT NULL,url TEXT NOT NULL,title TEXT NOT NULL,author TEXT NOT NULL,timestamp TEXT NOT NULL,raw_snippet TEXT DEFAULT '');
      CREATE TABLE IF NOT EXISTS history(id INTEGER PRIMARY KEY AUTOINCREMENT,item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,old_status TEXT,new_status TEXT NOT NULL,changed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS links(id TEXT PRIMARY KEY,item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,type TEXT NOT NULL,url TEXT NOT NULL,title TEXT NOT NULL,description TEXT DEFAULT '',created_at TEXT NOT NULL);`);
    const columns = new Set(
      (db.pragma('table_info(items)') as { name: string }[]).map((c) => c.name),
    );
    const additions: Record<string, string> = {
      starred: 'INTEGER DEFAULT 0',
      priority:
        "INTEGER NOT NULL DEFAULT 5 CHECK(typeof(priority)='integer' AND priority BETWEEN 1 AND 10)",
      parent_id: 'TEXT REFERENCES items(id) ON DELETE CASCADE',
      categories: "TEXT NOT NULL DEFAULT '[]'",
      goal_id: 'TEXT',
      intent: "TEXT DEFAULT ''",
      rationale: "TEXT DEFAULT ''",
      acceptance_criteria: "TEXT DEFAULT '[]'",
      idempotency_key: 'TEXT',
    };
    for (const [name, type] of Object.entries(additions))
      if (!columns.has(name)) {
        db.exec(`ALTER TABLE items ADD COLUMN ${name} ${type}`);
        if (name === 'priority')
          db.exec('UPDATE items SET priority=CASE WHEN starred=1 THEN 10 ELSE 5 END');
      }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_items_profile ON items(profile);
      CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
      CREATE INDEX IF NOT EXISTS idx_items_parent ON items(parent_id);
      CREATE INDEX IF NOT EXISTS idx_sources_item ON sources(item_id);
      CREATE INDEX IF NOT EXISTS idx_links_item ON links(item_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_items_idempotency_key ON items(idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE TABLE IF NOT EXISTS mitzo_telos_creation_receipts(request_id TEXT PRIMARY KEY,input_hash TEXT NOT NULL,item_id TEXT NOT NULL,receipt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS telos_work_lifecycle(item_id TEXT PRIMARY KEY REFERENCES items(id),data TEXT NOT NULL,purging INTEGER NOT NULL DEFAULT 0 CHECK(purging IN (0,1)));
      CREATE TABLE IF NOT EXISTS telos_item_updates(seq INTEGER PRIMARY KEY,item_id TEXT NOT NULL REFERENCES items(id),session_id TEXT NOT NULL,request_id TEXT NOT NULL,input_hash TEXT NOT NULL,note TEXT NOT NULL,old_status TEXT NOT NULL,new_status TEXT NOT NULL,created_at TEXT NOT NULL,receipt TEXT NOT NULL,UNIQUE(session_id,request_id));
      CREATE INDEX IF NOT EXISTS telos_item_updates_item ON telos_item_updates(item_id,seq);
      UPDATE items SET status='completed' WHERE status='done';`);
    if (
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='telos_runtime_creation_receipts'",
        )
        .get()
    ) {
      if (
        db
          .prepare(
            `SELECT 1 FROM telos_runtime_creation_receipts old
        JOIN mitzo_telos_creation_receipts current ON current.request_id=old.idempotency_key
        WHERE current.input_hash<>old.input_hash OR current.receipt<>old.receipt
          OR current.item_id<>json_extract(old.receipt,'$.item.id') LIMIT 1`,
          )
          .get()
      )
        throw Error('Conflicting retained Telos creation receipts require inspection');
      db.exec(`INSERT OR IGNORE INTO mitzo_telos_creation_receipts(request_id,input_hash,item_id,receipt)
        SELECT idempotency_key,input_hash,json_extract(receipt,'$.item.id'),receipt
        FROM telos_runtime_creation_receipts;`);
    }
  }).immediate();
}
