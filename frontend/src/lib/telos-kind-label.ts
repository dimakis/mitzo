import type { TelosWorkItem } from '@mitzo/protocol';
export const telosKindLabel = (kind: TelosWorkItem['kind']) =>
  kind === 'coordinator'
    ? 'Coordinator'
    : kind === 'outcome'
      ? 'Outcome'
      : kind === 'work_item'
        ? 'Work item'
        : 'Unclassified';
