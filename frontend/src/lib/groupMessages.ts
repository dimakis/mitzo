import type { FinishedBlock } from '../types/chat';
import { TOOL_GROUP_THRESHOLD } from './constants';

export type GroupedBlock =
  | { type: 'block'; block: FinishedBlock }
  | { type: 'tool-group'; tools: FinishedBlock[]; key: string };

/**
 * Group consecutive tool_use blocks into collapsible ToolGroups.
 * Blocks whose toolId appears in `progressToolIds` are excluded from grouping
 * (they render as ProgressWidget and should always be visible).
 */
export function groupBlocks(
  blocks: FinishedBlock[],
  progressToolIds?: Set<string>,
): GroupedBlock[] {
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
      // Progress-augmented blocks break the tool buffer (never grouped)
      if (block.toolId && progressToolIds?.has(block.toolId)) {
        flushTools();
        result.push({ type: 'block', block });
      } else {
        toolBuffer.push(block);
      }
    } else {
      flushTools();
      result.push({ type: 'block', block });
    }
  }
  flushTools();
  return result;
}
