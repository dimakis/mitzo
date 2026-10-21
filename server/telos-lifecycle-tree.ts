import { z } from 'zod';
import { TelosWorkLifecycleListSchema, type TelosWorkLifecycleView } from '@mitzo/protocol';
import type { TodoListResponse } from './api-schemas.js';
import { TelosWorkError } from './telos-work-store.js';

type CanonicalList = z.output<typeof TodoListResponse>;
export type TelosLifecycleVisibility = Pick<
  TelosWorkLifecycleView,
  'itemId' | 'effectiveDisposition'
>;
const node = z
  .object({
    id: z.string(),
    parentId: z.string().nullable(),
    status: z.enum(['active', 'acknowledged', 'snoozed', 'completed']),
    children: z.array(z.unknown()),
    childCount: z.number(),
    completedChildCount: z.number(),
  })
  .passthrough();
type Node = z.output<typeof node>;
const conflict = (message: string): never => {
  throw new TelosWorkError('conflict', message);
};

/** Pure presentation projection of the ORIGINAL TodoListResponse parser output.
 * For default active, the already-authenticated caller supplies same-database
 * work.lifecycleVisibilityForCanonicalList(originalParsedIds); no operator is
 * fabricated for existing internal-token readers. Archive/Trash require current
 * interactive authority and use work.listLifecycle(view, realOperator).
 * Missing lifecycle identities are omitted, never assumed active. Promotion is
 * presentation only: original parentId, briefs, sources, priority and age stay.
 * No DB write, reparent, status change, sorting, owner creation or file access.
 */
export function projectTelosLifecycleTree(
  canonical: CanonicalList,
  lifecycle: readonly TelosLifecycleVisibility[],
  rawView: 'active' | 'archive' | 'trash' = 'active',
): CanonicalList {
  const view = TelosWorkLifecycleListSchema.parse(rawView);
  const selected = { active: 'active', archive: 'archived', trash: 'trashed' }[view];
  if (lifecycle.length > 5000) conflict('Lifecycle projection exceeds bounded selection');
  const visible = new Set<string>();
  const known = new Set<string>();
  for (const row of lifecycle) {
    if (known.has(row.itemId)) conflict('Duplicate lifecycle identity');
    known.add(row.itemId);
    if (row.effectiveDisposition === selected) visible.add(row.itemId);
  }
  const seen = new Set<string>();
  const visit = (raw: unknown, depth: number): Node[] => {
    if (depth > 1000 || seen.size >= 5000) conflict('Lifecycle tree exceeds bounded selection');
    const value = node.parse(raw);
    if (seen.has(value.id)) conflict('Duplicate canonical lifecycle identity');
    seen.add(value.id);
    const children = value.children.flatMap((child) => visit(child, depth + 1));
    if (!visible.has(value.id)) return children;
    return [
      {
        ...value,
        children,
        childCount: children.length,
        completedChildCount: children.filter((child) => child.status === 'completed').length,
      },
    ];
  };
  return { ...canonical, items: canonical.items.flatMap((item) => visit(item, 0)) };
}
