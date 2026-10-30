import { z } from 'zod';
import { TelosWorkItemSchema } from '@mitzo/protocol';
import type { TodoData, TodoItem } from '../types/todo';

/** Keep the legacy fallback DTO derived from the same canonical records as the
 * workspace. Neither a mutable title nor a source fingerprint is an identity. */
export function canonicalTodoData(raw: unknown): TodoData {
  const data = z
    .object({
      profiles: z.array(z.string()),
      records: z.array(TelosWorkItemSchema).max(5000),
      failures: z.array(z.object({ itemId: z.string(), code: z.string() })),
    })
    .parse(raw);
  const nodes = new Map<string, TodoItem>();
  for (const record of data.records) {
    if (nodes.has(record.itemId)) throw Error('Duplicate canonical item identity');
    const legacy = (record.legacyFields.item ?? {}) as Record<string, unknown>;
    const firstSeen = typeof legacy.first_seen === 'string' ? Date.parse(legacy.first_seen) : NaN;
    nodes.set(record.itemId, {
      id: record.itemId,
      summary: record.summary,
      intent: record.intent,
      rationale: record.rationale,
      acceptanceCriteria: record.acceptanceCriteria,
      profile: record.profile,
      urgency: typeof legacy.urgency === 'number' ? legacy.urgency : 0,
      priority: record.priority,
      starred: record.starred,
      status: record.status,
      ageDays: Number.isFinite(firstSeen)
        ? Math.max(0, Math.floor((Date.now() - firstSeen) / 86400000))
        : 0,
      parentId: record.parentId,
      children: [],
      childCount: 0,
      completedChildCount: 0,
      sources: record.sources.map((source) => ({
        type: source.type,
        url: source.url,
        title: source.title,
        author: source.author ?? '',
        snippet: source.rawSnippet,
      })),
      links: record.links.map((link) => ({ ...link })),
      contextHints: record.contextHints,
      goalId: typeof legacy.goal_id === 'string' ? legacy.goal_id : null,
    });
  }
  const items: TodoItem[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) {
      parent.children.push(node);
      parent.childCount++;
      if (node.status === 'completed') parent.completedChildCount++;
    } else items.push(node);
  }
  return { profiles: data.profiles, items, records: data.records, recordFailures: data.failures };
}
