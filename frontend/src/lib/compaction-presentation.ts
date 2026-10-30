import type { ContextCompaction } from '@mitzo/protocol';
export const compactionLabel = (record: ContextCompaction) =>
  record.phase === 'compacting'
    ? 'Compacting context…'
    : record.phase === 'failed'
      ? 'Compaction failed'
      : record.phase === 'interrupted'
        ? 'Compaction interrupted'
        : record.phase === 'unknown'
          ? 'Compaction outcome unknown'
          : 'Context compacted';

/** Rounded wall time, not provider progress or a completion prediction. */
export function compactionDuration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}
