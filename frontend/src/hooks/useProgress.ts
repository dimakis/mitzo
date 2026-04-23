import { useMemo } from 'react';
import { useMitzoStore } from '@mitzo/client/hooks';
import type { ProgressBlock } from '@mitzo/protocol';

/** Derives a toolId → ProgressBlock lookup from the progress store slice. */
export function useProgressByToolId(): Record<string, ProgressBlock> {
  const toolIndex = useMitzoStore((s) => s.progress.toolIndex);
  const blocks = useMitzoStore((s) => s.progress.blocks);

  return useMemo(() => {
    const map: Record<string, ProgressBlock> = {};
    for (const [toolId, progressId] of Object.entries(toolIndex)) {
      const block = blocks[progressId];
      if (block) map[toolId] = block;
    }
    return map;
  }, [toolIndex, blocks]);
}
