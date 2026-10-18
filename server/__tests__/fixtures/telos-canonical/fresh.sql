CREATE TABLE history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL,
    old_status TEXT,
    new_status TEXT NOT NULL,
    changed_at TEXT NOT NULL,
    FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);

CREATE TABLE items (
    id TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    intent TEXT DEFAULT '',
    rationale TEXT DEFAULT '',
    acceptance_criteria TEXT DEFAULT '[]',
    idempotency_key TEXT,
    profile TEXT NOT NULL,
    cluster_id TEXT,
    urgency REAL DEFAULT 0.0,
    priority INTEGER NOT NULL DEFAULT 5 CHECK(typeof(priority)='integer' AND priority BETWEEN 1 AND 10),
    starred INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    snoozed_until TEXT,
    context_hints TEXT DEFAULT '{}',
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    parent_id TEXT REFERENCES items(id) ON DELETE CASCADE,
    goal_id TEXT
);

CREATE TABLE links (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    type TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);

CREATE TABLE sources (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    raw_snippet TEXT DEFAULT '',
    FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_items_idempotency_key
                   ON items(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_items_parent ON items(parent_id);

CREATE INDEX idx_items_profile ON items(profile);

CREATE INDEX idx_items_status ON items(status);

CREATE INDEX idx_links_item ON links(item_id);

CREATE INDEX idx_sources_item ON sources(item_id);
