import type { FinishedBlock } from '../types/chat';
import { TOOL_GROUP_THRESHOLD } from './constants';

export type GroupedBlock =
  | { type: 'block'; block: FinishedBlock }
  | { type: 'tool-group'; tools: FinishedBlock[]; key: string };

export function groupBlocks(blocks: FinishedBlock[]): GroupedBlock[] {
  if (!Array.isArray(blocks)) return [];
  const result: GroupedBlock[] = [];
  let toolBuffer: FinishedBlock[] = [];

  function flushTools() {
    if (toolBuffer.length === 0) return;
    if (toolBuffer.length >= TOOL_GROUP_THRESHOLD) {
      result.push({
        type: 'tool-group',
        tools: toolBuffer,
        key: toolBuffer[0].blockId ?? `tg-${result.length}`,
      });
    } else {
      for (const t of toolBuffer) result.push({ type: 'block', block: t });
    }
    toolBuffer = [];
  }

  for (const block of blocks) {
    if (block.blockType === 'tool_use') {
      toolBuffer.push(block);
    } else {
      flushTools();
      result.push({ type: 'block', block });
    }
  }
  flushTools();
  return result;
}
