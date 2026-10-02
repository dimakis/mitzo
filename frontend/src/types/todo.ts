export interface TodoSource {
  type: string;
  url: string;
  title: string;
  author: string;
  snippet: string;
}

export interface TodoContextHints {
  repos: string[];
  paths: string[];
  issues: string[];
  docIds: string[];
  people: string[];
  jiraKeys: string[];
  keywords: string[];
  taskHint: string;
  sessionIds?: string[];
}

export interface TodoLink {
  type: string;
  url: string;
  title: string;
  description: string;
}

export interface TodoItem {
  id: string;
  summary: string;
  intent?: string;
  rationale?: string;
  acceptanceCriteria?: string[];
  profile: string;
  urgency: number;
  starred: boolean;
  status: 'active' | 'acknowledged' | 'snoozed' | 'completed';
  ageDays: number;
  parentId: string | null;
  children: TodoItem[];
  childCount: number;
  completedChildCount: number;
  sources: TodoSource[];
  links?: TodoLink[];
  contextHints: TodoContextHints;
  goalId: string | null;
}

export interface TodoData {
  profiles: string[];
  items: TodoItem[];
}

export interface TodoOutcomeDraft {
  summary: string;
  intent: string;
  rationale: string;
  acceptanceCriteria: string[];
  milestones: string[];
  profile: string;
  idempotencyKey: string;
}
