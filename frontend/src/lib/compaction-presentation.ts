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
