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
}

export interface TodoItem {
  id: string;
  summary: string;
  profile: string;
  urgency: number;
  status: 'active' | 'acknowledged' | 'snoozed' | 'completed';
  ageDays: number;
  parentId: string | null;
  children: TodoItem[];
  childCount: number;
  completedChildCount: number;
  sources: TodoSource[];
  contextHints: TodoContextHints;
}

export interface TodoData {
  profiles: string[];
  items: TodoItem[];
}
