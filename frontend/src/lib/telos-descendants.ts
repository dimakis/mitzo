/** Linear membership traversal, independent of row order. Keep presentation order
 * at the caller; cycles and overlapping paths never enqueue a record twice. */
export function telosDescendants(
  records: readonly { itemId: string; parentId: string | null }[],
  rootId: string,
): Set<string> {
  const children = new Map<string, string[]>();
  for (const { itemId, parentId } of records) {
    if (!parentId) continue;
    const siblings = children.get(parentId) ?? [];
    siblings.push(itemId);
    children.set(parentId, siblings);
  }
  const selected = new Set([rootId]);
  const queue = [rootId];
  for (let index = 0; index < queue.length; index++) {
    for (const id of children.get(queue[index]) ?? []) {
      if (selected.has(id)) continue;
      selected.add(id);
      queue.push(id);
    }
  }
  return selected;
}
