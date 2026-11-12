import type { TelosWorkItem } from '@mitzo/protocol';
export const telosKindLabel = (kind: TelosWorkItem['kind']) =>
  kind === 'coordinator'
    ? 'Outcome'
    : kind === 'outcome'
      ? 'Feature'
      : kind === 'work_item'
        ? 'Slice'
        : 'Unclassified';
