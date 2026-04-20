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

export type StageType = 'agent_work' | 'wait_for_signal' | 'human_review';

export interface GateConfig {
  type: 'gh_ci' | 'gh_review' | 'centaur_review' | 'human_approval' | 'compound';
  [key: string]: unknown;
}

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
  stageType: StageType | null;
  gateConfig: GateConfig | null;
  artifacts: Record<string, unknown> | null;
  retryCount: number;
  maxRetries: number;
  templateId: string | null;
  children: Task[];
}

export interface TaskCreateInput {
  title: string;
  parentId?: string;
  description?: string;
  priority?: number;
  sessionPolicy?: SessionPolicy;
  annotations?: string[];
  stageType?: StageType;
  gateConfig?: GateConfig;
  maxRetries?: number;
  templateId?: string;
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
  stageType?: StageType;
  gateConfig?: GateConfig;
  artifacts?: Record<string, unknown>;
  retryCount?: number;
  maxRetries?: number;
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
  stage_type: string | null;
  gate_config: string | null;
  artifacts: string | null;
  retry_count: number;
  max_retries: number;
  template_id: string | null;
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
    completed_at    REAL,
    stage_type      TEXT DEFAULT NULL
                    CHECK(stage_type IS NULL OR stage_type IN ('agent_work','wait_for_signal','human_review')),
    gate_config     TEXT DEFAULT NULL,
    artifacts       TEXT DEFAULT NULL,
    retry_count     INTEGER NOT NULL DEFAULT 0,
    max_retries     INTEGER NOT NULL DEFAULT 0,
    template_id     TEXT DEFAULT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);
`;

const MIGRATIONS = [
  // Migration 1: Add workflow columns to existing tasks table
  {
    check: "SELECT COUNT(*) as cnt FROM pragma_table_info('tasks') WHERE name = 'stage_type'",
    sql: `
      ALTER TABLE tasks ADD COLUMN stage_type TEXT DEFAULT NULL
        CHECK(stage_type IS NULL OR stage_type IN ('agent_work','wait_for_signal','human_review'));
      ALTER TABLE tasks ADD COLUMN gate_config TEXT DEFAULT NULL;
      ALTER TABLE tasks ADD COLUMN artifacts TEXT DEFAULT NULL;
      ALTER TABLE tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN template_id TEXT DEFAULT NULL;
    `,
  },
];

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
    stageType: (row.stage_type as StageType) ?? null,
    gateConfig: row.gate_config ? JSON.parse(row.gate_config) : null,
    artifacts: row.artifacts ? JSON.parse(row.artifacts) : null,
    retryCount: row.retry_count ?? 0,
    maxRetries: row.max_retries ?? 0,
    templateId: row.template_id ?? null,
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
    this.runMigrations(db);
    log.info('TaskStore initialized', { dbPath });
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private getDb(): Database.Database {
    if (!this.db) throw new Error('TaskStore is closed');
    return this.db;
  }

  private runMigrations(db: Database.Database): void {
    for (const migration of MIGRATIONS) {
      const row = db.prepare(migration.check).get() as { cnt: number };
      if (row.cnt === 0) {
        log.info('Running migration', { check: migration.check });
        db.exec(migration.sql);
      }
    }
  }

  create(input: TaskCreateInput): Task {
    const db = this.getDb();
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
    const gateConfig = input.gateConfig ? JSON.stringify(input.gateConfig) : null;

    db.prepare(
      `INSERT INTO tasks (id, parent_id, title, description, status, session_policy, priority, depth, annotations, stage_type, gate_config, max_retries, template_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.parentId ?? null,
      input.title,
      input.description ?? null,
      input.sessionPolicy ?? 'auto',
      input.priority ?? 0,
      depth,
      annotations,
      input.stageType ?? null,
      gateConfig,
      input.maxRetries ?? 0,
      input.templateId ?? null,
      now,
      now,
    );

    return this.get(id)!;
  }

  get(id: string): Task | null {
    const row = this.getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      | TaskRow
      | undefined;
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
    if (fields.stageType !== undefined) {
      sets.push('stage_type = ?');
      values.push(fields.stageType);
    }
    if (fields.gateConfig !== undefined) {
      sets.push('gate_config = ?');
      values.push(JSON.stringify(fields.gateConfig));
    }
    if (fields.artifacts !== undefined) {
      sets.push('artifacts = ?');
      values.push(JSON.stringify(fields.artifacts));
    }
    if (fields.retryCount !== undefined) {
      sets.push('retry_count = ?');
      values.push(fields.retryCount);
    }
    if (fields.maxRetries !== undefined) {
      sets.push('max_retries = ?');
      values.push(fields.maxRetries);
    }

    if (sets.length === 0) return existing;

    sets.push('updated_at = ?');
    values.push(Date.now());
    values.push(id);

    this.getDb()
      .prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`)
      .run(...values);

    return this.get(id);
  }

  delete(id: string): boolean {
    const result = this.getDb().prepare('DELETE FROM tasks WHERE id = ?').run(id);
    return result.changes > 0;
  }

  listRoots(): Task[] {
    const rows = this.getDb()
      .prepare('SELECT * FROM tasks WHERE parent_id IS NULL ORDER BY priority DESC, created_at ASC')
      .all() as TaskRow[];
    return rows.map(rowToTask);
  }

  getChildren(parentId: string): Task[] {
    const rows = this.getDb()
      .prepare('SELECT * FROM tasks WHERE parent_id = ? ORDER BY priority DESC, created_at ASC')
      .all(parentId) as TaskRow[];
    return rows.map(rowToTask);
  }

  getTree(): Task[] {
    const rows = this.getDb()
      .prepare('SELECT * FROM tasks ORDER BY priority DESC, created_at ASC')
      .all() as TaskRow[];
    return this.assembleTree(rows);
  }

  getSubtree(rootId: string): Task[] {
    // Fetch all tasks and filter to subtree
    const allRows = this.getDb()
      .prepare('SELECT * FROM tasks ORDER BY priority DESC, created_at ASC')
      .all() as TaskRow[];
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

  /** Derive a parent's status from its children per §2.3 cascade rules. */
  deriveParentStatus(parentId: string): TaskStatus {
    const children = this.getChildren(parentId);
    if (children.length === 0) return this.get(parentId)?.status ?? 'pending';

    if (children.some((c) => c.status === 'failed')) return 'failed';
    if (children.some((c) => c.status === 'blocked')) return 'blocked';
    if (children.some((c) => c.status === 'active')) return 'active';
    if (children.some((c) => c.status === 'pending_review')) return 'pending_review';
    if (children.every((c) => c.status === 'done' || c.status === 'skipped')) return 'done';
    return 'pending';
  }

  /** Walk up the parent chain applying deriveParentStatus. Stops when status unchanged. */
  cascadeStatus(taskId: string): void {
    const task = this.get(taskId);
    if (!task?.parentId) return;

    let currentId: string | null = task.parentId;
    while (currentId) {
      const derived = this.deriveParentStatus(currentId);
      const parent = this.get(currentId);
      if (!parent) break;
      if (parent.status === derived) break;
      this.update(currentId, { status: derived });
      currentId = parent.parentId;
    }
  }

  /** All tasks assigned to a given session. */
  getBySession(sessionId: string): Task[] {
    const rows = this.getDb()
      .prepare('SELECT * FROM tasks WHERE session_id = ? ORDER BY priority DESC, created_at ASC')
      .all(sessionId) as TaskRow[];
    return rows.map(rowToTask);
  }

  /** Assign or unassign a session to a task. */
  setSessionId(taskId: string, sessionId: string | null): Task | null {
    const existing = this.get(taskId);
    if (!existing) return null;

    const now = Date.now();
    this.getDb()
      .prepare(
        'UPDATE tasks SET session_id = ?, claimed_by = ?, claimed_at = ?, updated_at = ? WHERE id = ?',
      )
      .run(sessionId, sessionId, sessionId ? now : null, now, taskId);

    return this.get(taskId);
  }

  /**
   * DFS: find the deepest-left pending leaf task.
   * Skips subtrees rooted at blocked/failed ancestors.
   * If parentId given, searches within that subtree; otherwise searches all roots.
   */
  getNextExecutable(parentId?: string): Task | null {
    const candidates = parentId ? this.getChildren(parentId) : this.listRoots();

    for (const task of candidates) {
      // Skip terminal or blocked subtrees
      if (TERMINAL_STATUSES.has(task.status) || task.status === 'blocked') continue;

      // Check children first (DFS — go deeper before returning this node)
      const children = this.getChildren(task.id);
      if (children.length > 0) {
        const deeperResult = this.getNextExecutable(task.id);
        if (deeperResult) return deeperResult;
        continue; // Parent with children is not itself executable
      }

      // Leaf node — only pending leaves are executable
      if (task.status === 'pending') return task;
    }

    return null;
  }

  /** Find active tasks whose session_id is not in the set of active sessions. */
  getOrphaned(activeSessionIds: Set<string>): Task[] {
    const rows = this.getDb()
      .prepare("SELECT * FROM tasks WHERE status = 'active' AND session_id IS NOT NULL")
      .all() as TaskRow[];
    return rows.map(rowToTask).filter((t) => !activeSessionIds.has(t.sessionId!));
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
