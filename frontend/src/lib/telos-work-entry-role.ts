import type { TelosWorkView } from '@mitzo/protocol';

/** Coordinator control authority still requires an explicit current lead
 * assignment through reviewed ordinary setup; additional links grant none. */
export function telosWorkEntryRole(kind: TelosWorkView['kind']): 'lead' | 'worker' | null {
  return kind === 'work_item'
    ? 'worker'
    : kind === 'outcome' || kind === 'coordinator'
      ? 'lead'
      : null;
}
