// Mirror of backend TodoItem type
export interface WorkloadSource {
  sourceType: string;
  sourceId: string;
  url: string;
  title: string;
  author: string;
  timestamp: number;
  snippet: string;
}

export interface WorkloadContextHints {
  repos: string[];
  paths: string[];
  issues: string[];
  docIds: string[];
  people: string[];
  jiraKeys: string[];
  keywords: string[];
  taskHint: string;
}

export interface WorkloadItem {
  id: string;
  title: string;
  snippet: string | null;
  status: 'active' | 'acknowledged' | 'snoozed' | 'completed';
  profile: string;
  urgency: number;
  starred: boolean;
  snoozedUntil: string | null;
  contextHints: WorkloadContextHints;
  clusterId: string | null;
  goalId: string | null;
  sources: WorkloadSource[];
  createdAt: number;
  updatedAt: number;
}

export interface WorkloadState {
  items: WorkloadItem[];
  profiles: string[];
}

export const INITIAL_WORKLOAD_STATE: WorkloadState = {
  items: [],
  profiles: [],
};

// Helper to update item in tree
export function updateWorkloadItem(items: WorkloadItem[], updated: WorkloadItem): WorkloadItem[] {
  return items.map((item) => (item.id === updated.id ? updated : item));
}

// Helper to add item if not exists
export function upsertWorkloadItem(items: WorkloadItem[], newItem: WorkloadItem): WorkloadItem[] {
  const exists = items.some((item) => item.id === newItem.id);
  if (exists) {
    return updateWorkloadItem(items, newItem);
  }
  return [...items, newItem];
}

// Helper to batch update
export function batchUpdateWorkloadItems(
  items: WorkloadItem[],
  updates: WorkloadItem[],
): WorkloadItem[] {
  let result = items;
  for (const update of updates) {
    result = upsertWorkloadItem(result, update);
  }
  return result;
}
