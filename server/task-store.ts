import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { createLogger } from './logger.js';

const log = createLogger('task-store');

export type TaskStatus =
  | 'pending'
  | 'active'
  | 'done'
  | 'pending_review'
  | 'blocked'
  | 'skipped'
  | 'failed';

export type SessionPolicy = 'reuse' | 'spawn' | 'auto';

const TERMINAL_STATUSES: Set<TaskStatus> = new Set(['done', 'skipped', 'failed']);

export interface Task {
  id: string;
  parentId: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  sessionId: string | null;
  sessionPolicy: SessionPolicy;
  priority: number;
  depth: number;
  annotations: string[];
  summary: string | null;
  requiresApproval: boolean;
  tokenUsage: number;
  claimedBy: string | null;
  claimedAt: number | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  children: Task[];
}

export interface TaskCreateInput {
  title: string;
  parentId?: string;
  description?: string;
  priority?: number;
  sessionPolicy?: SessionPolicy;
  annotations?: string[];
}

export interface TaskUpdateInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: number;
  sessionPolicy?: SessionPolicy;
  annotations?: string[];
  summary?: string;
  requiresApproval?: boolean;
}

interface TaskRow {
  id: string;
  parent_id: string | null;
  title: string;
  description: string | null;
  status: string;
  session_id: string | null;
  session_policy: string;
  priority: number;
  depth: number;
  annotations: string | null;
  summary: string | null;
  requires_approval: number;
  token_usage: number;
  claimed_by: string | null;
  claimed_at: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tasks (
    id              TEXT PRIMARY KEY,
    parent_id       TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    description     TEXT,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending','active','done','pending_review','blocked','skipped','failed')),
    session_id      TEXT,
    session_policy  TEXT NOT NULL DEFAULT 'auto'
                    CHECK(session_policy IN ('reuse','spawn','auto')),
    priority        INTEGER NOT NULL DEFAULT 0,
    depth           INTEGER NOT NULL DEFAULT 0
                    CHECK(depth >= 0),
    annotations     TEXT,
    summary         TEXT,
    requires_approval INTEGER NOT NULL DEFAULT 0,
    token_usage     INTEGER NOT NULL DEFAULT 0,
    claimed_by      TEXT,
    claimed_at      REAL,
    created_at      REAL NOT NULL,
    updated_at      REAL NOT NULL,
    completed_at    REAL
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
`;

function rowToTask(row: TaskRow): Task {
  let annotations: string[] = [];
  if (row.annotations) {
    try {
      annotations = JSON.parse(row.annotations);
    } catch {
      annotations = [];
    }
  }
  return {
    id: row.id,
    parentId: row.parent_id,
    title: row.title,
    description: row.description,
    status: row.status as TaskStatus,
    sessionId: row.session_id,
    sessionPolicy: row.session_policy as SessionPolicy,
    priority: row.priority,
    depth: row.depth,
    annotations,
    summary: row.summary,
    requiresApproval: row.requires_approval === 1,
    tokenUsage: row.token_usage,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    children: [],
  };
}

export class TaskStore {
  private db: Database.Database | null;

  constructor(dbPath: string) {
    const db = new Database(dbPath);
    this.db = db;
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA);
    log.info('TaskStore initialized', { dbPath });
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  create(input: TaskCreateInput): Task {
    const db = this.db!;
    const id = randomUUID();
    const now = Date.now();

    let depth = 0;
    if (input.parentId) {
      const parentRow = db.prepare('SELECT depth FROM tasks WHERE id = ?').get(input.parentId) as
        | { depth: number }
        | undefined;
      if (!parentRow) {
        throw new Error(`Parent task not found: ${input.parentId}`);
      }
      depth = parentRow.depth + 1;
    }

    const annotations = input.annotations ? JSON.stringify(input.annotations) : null;

    db.prepare(
      `INSERT INTO tasks (id, parent_id, title, description, status, session_policy, priority, depth, annotations, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.parentId ?? null,
      input.title,
      input.description ?? null,
      input.sessionPolicy ?? 'auto',
      input.priority ?? 0,
      depth,
      annotations,
      now,
      now,
    );

    return this.get(id)!;
  }

  get(id: string): Task | null {
    const row = this.db!.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  update(id: string, fields: TaskUpdateInput): Task | null {
    const existing = this.get(id);
    if (!existing) return null;

    const sets: string[] = [];
    const values: unknown[] = [];

    if (fields.title !== undefined) {
      sets.push('title = ?');
      values.push(fields.title);
    }
    if (fields.description !== undefined) {
      sets.push('description = ?');
      values.push(fields.description);
    }
    if (fields.status !== undefined) {
      sets.push('status = ?');
      values.push(fields.status);

      if (TERMINAL_STATUSES.has(fields.status)) {
        sets.push('completed_at = ?');
        values.push(Date.now());
      } else {
        sets.push('completed_at = ?');
        values.push(null);
      }
    }
    if (fields.priority !== undefined) {
      sets.push('priority = ?');
      values.push(fields.priority);
    }
    if (fields.sessionPolicy !== undefined) {
      sets.push('session_policy = ?');
      values.push(fields.sessionPolicy);
    }
    if (fields.annotations !== undefined) {
      sets.push('annotations = ?');
      values.push(JSON.stringify(fields.annotations));
    }
    if (fields.summary !== undefined) {
      sets.push('summary = ?');
      values.push(fields.summary);
    }
    if (fields.requiresApproval !== undefined) {
      sets.push('requires_approval = ?');
      values.push(fields.requiresApproval ? 1 : 0);
    }

    if (sets.length === 0) return existing;

    sets.push('updated_at = ?');
    values.push(Date.now());
    values.push(id);

    this.db!.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);

    return this.get(id);
  }

  delete(id: string): boolean {
    const result = this.db!.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    return result.changes > 0;
  }

  listRoots(): Task[] {
    const rows = this.db!.prepare(
      'SELECT * FROM tasks WHERE parent_id IS NULL ORDER BY priority DESC, created_at ASC',
    ).all() as TaskRow[];
    return rows.map(rowToTask);
  }

  getChildren(parentId: string): Task[] {
    const rows = this.db!.prepare(
      'SELECT * FROM tasks WHERE parent_id = ? ORDER BY priority DESC, created_at ASC',
    ).all(parentId) as TaskRow[];
    return rows.map(rowToTask);
  }

  getTree(): Task[] {
    const rows = this.db!.prepare(
      'SELECT * FROM tasks ORDER BY priority DESC, created_at ASC',
    ).all() as TaskRow[];
    return this.assembleTree(rows);
  }

  getSubtree(rootId: string): Task[] {
    // Fetch all tasks and filter to subtree
    const allRows = this.db!.prepare(
      'SELECT * FROM tasks ORDER BY priority DESC, created_at ASC',
    ).all() as TaskRow[];
    const allTasks = allRows.map(rowToTask);

    const rootTask = allTasks.find((t) => t.id === rootId);
    if (!rootTask) return [];

    // Build parent->children map
    const childMap = new Map<string, Task[]>();
    for (const task of allTasks) {
      if (task.parentId) {
        const siblings = childMap.get(task.parentId) ?? [];
        siblings.push(task);
        childMap.set(task.parentId, siblings);
      }
    }

    // Recursively build tree from root
    function buildSubtree(task: Task): Task {
      const children = childMap.get(task.id) ?? [];
      return { ...task, children: children.map(buildSubtree) };
    }

    return [buildSubtree(rootTask)];
  }

  private assembleTree(rows: TaskRow[]): Task[] {
    const tasks = rows.map(rowToTask);
    const taskMap = new Map<string, Task>();
    for (const task of tasks) {
      taskMap.set(task.id, task);
    }

    const roots: Task[] = [];
    for (const task of tasks) {
      if (task.parentId) {
        const parent = taskMap.get(task.parentId);
        if (parent) {
          parent.children.push(task);
        }
      } else {
        roots.push(task);
      }
    }

    return roots;
  }
}
