import type { ContextCompaction } from '@mitzo/protocol';
export const compactionLabel = (record: ContextCompaction) =>
  record.phase === 'compacting'
    ? 'Compacting context…'
    : record.phase === 'failed'
      ? 'Compaction failed'
      : 'Context compacted';
