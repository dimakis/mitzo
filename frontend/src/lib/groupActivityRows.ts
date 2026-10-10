import type { ChatBlock } from './groupMessages';

export interface ActivityRow<T> {
  key: string;
  scope: string;
  value: T;
  attribution?: T;
  block?: ChatBlock;
  streaming?: boolean;
  keepVisible?: boolean;
}

/** Group activity across provider message boundaries, but never across speakers or responses. */
export function groupActivityRows<T>(rows: ActivityRow<T>[]) {
  const result: Array<
    { type: 'row'; row: ActivityRow<T> } | { type: 'activity'; key: string; rows: ActivityRow<T>[] }
  > = [];
  for (const row of rows) {
    const activity =
      !row.keepVisible &&
      ['thinking', 'redacted_thinking', 'tool_use'].includes(row.block?.blockType ?? '');
    const previous = result.at(-1);
    if (activity && previous?.type === 'activity' && previous.rows[0].scope === row.scope) {
      previous.rows.push(row);
    } else if (activity) {
      result.push({ type: 'activity', key: row.key, rows: [row] });
    } else {
      result.push({ type: 'row', row });
    }
  }
  return result;
}
