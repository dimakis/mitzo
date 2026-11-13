import type { Session } from '../types/chat';
export interface ConversationTreeNode {
  session: Session;
  children: ConversationTreeNode[];
  unloaded?: boolean;
}

/** Stable presentation over loaded chats. Missing pages and malformed historical
 * cycles must never make a known chat disappear. */
export function conversationTree(sessions: Session[]): ConversationTreeNode[] {
  const nodes = new Map<string, ConversationTreeNode>();
  for (const session of sessions) nodes.set(session.id, { session, children: [] });
  for (const session of sessions)
    for (const ancestor of session.conversationAncestors ?? [])
      if (!nodes.has(ancestor.id))
        nodes.set(ancestor.id, {
          session: { ...ancestor, lastModified: session.lastModified },
          children: [],
          unloaded: true,
        });
  const roots: ConversationTreeNode[] = [];
  for (const node of [...nodes.values()]) {
    const parentId = node.session.parentConversationId;
    if (!parentId || parentId === node.session.id) {
      roots.push(node);
      continue;
    }
    const seen = new Set([node.session.id]);
    let cursor: string | undefined = parentId;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = nodes.get(cursor)?.session.parentConversationId;
    }
    if (cursor) {
      roots.push(node);
      continue;
    }
    let parent = nodes.get(parentId);
    if (!parent) {
      parent = {
        session: {
          id: parentId,
          summary: node.session.parentConversationTitle || 'Parent conversation',
          lastModified: node.session.lastModified,
        },
        children: [],
        unloaded: true,
      };
      nodes.set(parentId, parent);
      roots.push(parent);
    }
    parent.children.push(node);
  }
  return roots;
}
