import type { TelosWorkItem } from '@mitzo/protocol';
import { todoPriority } from './todo-utils';
export const telosSortOptions = [
  ['default', 'Default order'],
  ['priority-desc', 'Priority: high to low'],
  ['priority-asc', 'Priority: low to high'],
  ['newest', 'Newest first'],
  ['oldest', 'Oldest first'],
] as const;
export type TelosOutcomeSort = (typeof telosSortOptions)[number][0];
export function knownCreationTime(record: TelosWorkItem): number | null {
  const time = record.createdAt ? Date.parse(record.createdAt) : NaN;
  return Number.isFinite(time) ? time : null;
}
/** Sort siblings only. Equal and unknown values retain their owner's order. */
export function sortTelosSiblings(records: TelosWorkItem[], sort: TelosOutcomeSort) {
  if (sort === 'default') return records;
  return [...records].sort((a, b) => {
    if (sort === 'priority-desc') return todoPriority(b) - todoPriority(a);
    if (sort === 'priority-asc') return todoPriority(a) - todoPriority(b);
    const left = knownCreationTime(a),
      right = knownCreationTime(b);
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    return sort === 'oldest' ? left - right : right - left;
  });
}
