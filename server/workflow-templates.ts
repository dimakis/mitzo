import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { TaskStore, StageType, GateConfig } from './task-store.js';
import { createLogger } from './logger.js';

const log = createLogger('workflow-templates');

export interface TemplateStage {
  title: string;
  description?: string;
  stage_type: StageType;
  gate_config?: GateConfig;
  max_retries?: number;
  priority?: number;
  requires_approval?: boolean;
}

export interface TemplateVariable {
  description: string;
  default?: string;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string | null;
  stages: TemplateStage[];
  variables: Record<string, TemplateVariable> | null;
  createdAt: number;
  updatedAt: number;
}

export interface TemplateCreateInput {
  name: string;
  description?: string;
  stages: TemplateStage[];
  variables?: Record<string, TemplateVariable>;
}

interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  stages: string;
  variables: string | null;
  created_at: number;
  updated_at: number;
}

const TEMPLATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS workflow_templates (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    description TEXT,
    stages      TEXT NOT NULL,
    variables   TEXT,
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL
  );
`;

function rowToTemplate(row: TemplateRow): WorkflowTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    stages: JSON.parse(row.stages),
    variables: row.variables ? JSON.parse(row.variables) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class WorkflowTemplateStore {
  private db: Database.Database | null;

  constructor(dbPath: string) {
    const db = new Database(dbPath);
    this.db = db;
    db.pragma('journal_mode = WAL');
    db.exec(TEMPLATE_SCHEMA);
    log.info('WorkflowTemplateStore initialized', { dbPath });
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private getDb(): Database.Database {
    if (!this.db) throw new Error('WorkflowTemplateStore is closed');
    return this.db;
  }

  create(input: TemplateCreateInput): WorkflowTemplate {
    const id = randomUUID();
    const now = Date.now();
    this.getDb()
      .prepare(
        `INSERT INTO workflow_templates (id, name, description, stages, variables, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.description ?? null,
        JSON.stringify(input.stages),
        input.variables ? JSON.stringify(input.variables) : null,
        now,
        now,
      );
    return this.get(id)!;
  }

  get(id: string): WorkflowTemplate | null {
    const row = this.getDb()
      .prepare('SELECT * FROM workflow_templates WHERE id = ?')
      .get(id) as TemplateRow | undefined;
    return row ? rowToTemplate(row) : null;
  }

  list(): WorkflowTemplate[] {
    const rows = this.getDb()
      .prepare('SELECT * FROM workflow_templates ORDER BY name ASC')
      .all() as TemplateRow[];
    return rows.map(rowToTemplate);
  }

  delete(id: string): boolean {
    const result = this.getDb()
      .prepare('DELETE FROM workflow_templates WHERE id = ?')
      .run(id);
    return result.changes > 0;
  }
}

/** Replace all {{variable}} placeholders in a string. */
function substituteVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return key in vars ? vars[key] : match;
  });
}

/** Deep-substitute all string values in a JSON-serializable object. */
function substituteDeep<T>(obj: T, vars: Record<string, string>): T {
  if (typeof obj === 'string') return substituteVars(obj, vars) as T;
  if (Array.isArray(obj)) return obj.map((item) => substituteDeep(item, vars)) as T;
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = substituteDeep(value, vars);
    }
    return result as T;
  }
  return obj;
}

/**
 * Instantiate a workflow template as a task tree.
 * Creates a root goal task + child tasks for each stage.
 */
export function instantiateTemplate(
  taskStore: TaskStore,
  templateStore: WorkflowTemplateStore,
  templateId: string,
  goalTitle: string,
  variables: Record<string, string>,
) {
  const template = templateStore.get(templateId);
  if (!template) throw new Error(`Template not found: ${templateId}`);

  // Create the root goal
  const goal = taskStore.create({
    title: goalTitle,
    templateId,
  });

  // Create child tasks — priority is inverse of index so DFS picks them in order
  // (getChildren sorts by priority DESC, so first stage gets highest priority)
  const stageCount = template.stages.length;
  for (let i = 0; i < stageCount; i++) {
    const stage = substituteDeep(template.stages[i], variables);
    taskStore.create({
      title: stage.title,
      description: stage.description,
      parentId: goal.id,
      stageType: stage.stage_type,
      gateConfig: stage.gate_config,
      maxRetries: stage.max_retries ?? 0,
      priority: stageCount - i, // first stage gets highest priority
      templateId,
    });
  }

  return taskStore.get(goal.id)!;
}
