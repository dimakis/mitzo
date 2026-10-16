import { z } from 'zod';
import { TelosWorkItemSchema, type TelosWorkItem } from '@mitzo/protocol';

type Row = Record<string, unknown>;
const object = z.record(z.string(), z.unknown());
function storedJson(value: unknown, fallback: unknown): unknown {
  if (value === null || value === undefined) return fallback;
  return JSON.parse(z.string().parse(value));
}
const date = (value: unknown) => (value === '' ? null : (value ?? null));

/** Read-only projection of canonical MGMT rows. Keep their complete original
 * representation alongside the workspace fields, including unknown extensions.
 * No clock, derived category, inferred role or replacement artifact is involved.
 * Invalid stored JSON/types fail the read rather than silently dropping evidence.
 */
export function projectTelosWorkRecord(
  item: Row,
  sources: Row[],
  links: Row[],
  kind: TelosWorkItem['kind'],
): TelosWorkItem {
  const hints = object.parse(storedJson(item.context_hints, {}));
  const starred = z.union([z.literal(0), z.literal(1), z.boolean()]).parse(item.starred ?? 0);
  return TelosWorkItemSchema.parse({
    version: 1,
    itemId: item.id,
    kind,
    parentId: item.parent_id ?? null,
    summary: item.summary ?? '',
    intent: item.intent ?? '',
    rationale: item.rationale ?? '',
    acceptanceCriteria: storedJson(item.acceptance_criteria, []),
    profile: item.profile ?? '',
    status: item.status,
    starred: starred === true || starred === 1,
    categories: storedJson(item.categories, []),
    createdAt: date(item.created_at),
    updatedAt: date(item.updated_at),
    contextHints: {
      repos: hints.repos ?? [],
      paths: hints.paths ?? [],
      issues: hints.issues ?? [],
      docIds: hints.doc_ids ?? [],
      people: hints.people ?? [],
      jiraKeys: hints.jira_keys ?? [],
      keywords: hints.keywords ?? [],
      sessionIds: hints.session_ids ?? [],
      taskHint: hints.task_hint ?? '',
    },
    sources: sources.map((source) => ({
      type: source.type,
      url: source.url,
      title: source.title,
      author: source.author ?? null,
      rawSnippet: source.raw_snippet ?? '',
      // timestamp belongs to the source; it is not the date it was linked.
      createdAt: date(source.timestamp),
      addedAt: date(source.added_at),
      updatedAt: date(source.updated_at),
    })),
    links: links.map((link) => ({
      type: link.type,
      url: link.url,
      title: link.title,
      description: link.description ?? '',
      addedAt: date(link.created_at),
    })),
    legacyFields: { item, sources, links },
  });
}
