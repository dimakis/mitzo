import type { ChatBlock } from './groupMessages';

export interface ActivityRow<T> {
  key: string;
  scope: string;
  value: T;
  attribution?: T;
  block?: ChatBlock;
  streaming?: boolean;
  keepVisible?: boolean;
  endsTurn?: boolean;
  /** Message controls that can remain inside this speaker's preceding activity. */
  activityControl?: boolean;
}

/** Group activity across provider message boundaries, but never across speakers or responses. */
export function groupActivityRows<T>(rows: ActivityRow<T>[]) {
  const result: Array<
    | { type: 'row'; row: ActivityRow<T> }
    | { type: 'activity'; key: string; rows: ActivityRow<T>[]; replied: boolean }
  > = [];
  for (const row of rows) {
    if (row.block?.blockType === 'text' && !row.block.content?.trim()) continue;
    const activity =
      !row.keepVisible &&
      ['thinking', 'redacted_thinking', 'tool_use'].includes(row.block?.blockType ?? '');
    const previous = result.at(-1);
    if (
      (activity || (row.activityControl && !row.keepVisible)) &&
      previous?.type === 'activity' &&
      previous.rows[0].scope === row.scope
    ) {
      previous.rows.push(row);
    } else if (activity) {
      result.push({ type: 'activity', key: row.key, rows: [row], replied: false });
    } else {
      result.push({ type: 'row', row });
    }
  }
  // A provider's message_end is not a reply. Only visible assistant text in
  // this speaker's turn completes its preceding activity, even across progress
  // or other speakers' rows. A new user turn cannot answer an older one.
  const repliedScopes = new Set<string>();
  for (let index = result.length - 1; index >= 0; index--) {
    const item = result[index];
    if (item.type === 'activity') {
      item.replied = repliedScopes.has(item.rows[0].scope);
    } else if (item.row.endsTurn) {
      repliedScopes.clear();
    } else if (item.row.block?.blockType === 'text' && item.row.block.content?.trim()) {
      repliedScopes.add(item.row.scope);
    }
  }
  return result;
}
