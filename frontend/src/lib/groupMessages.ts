import type { FinishedBlock, StreamingBlock } from '../types/chat';

export type ChatBlock = FinishedBlock | StreamingBlock;

export type GroupedBlock<T extends ChatBlock = FinishedBlock> =
  { type: 'block'; block: T } | { type: 'tool-group'; tools: T[]; key: string };

/**
 * Group consecutive tool_use blocks into collapsible ToolGroups.
 * Blocks whose toolId appears in `progressToolIds` are excluded from grouping
 * (they render as ProgressWidget and should always be visible).
 */
export function groupBlocks<T extends ChatBlock>(
  blocks: T[],
  progressToolIds?: Set<string>,
): GroupedBlock<T>[] {
  if (!Array.isArray(blocks)) return [];
  const result: GroupedBlock<T>[] = [];
  let toolBuffer: T[] = [];

  function flushTools() {
    if (toolBuffer.length === 0) return;
    result.push({
      type: 'tool-group',
      tools: toolBuffer,
      key: toolBuffer[0].blockId ?? `tg-${result.length}`,
    });
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
