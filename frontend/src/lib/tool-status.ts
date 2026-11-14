import type { FinishedBlock, StreamingBlock } from '../types/chat';
import { ToolFailureSchema } from '@mitzo/protocol';

export type ToolBlock = FinishedBlock | StreamingBlock;

/** Display only; a result label never grants recovery or execution authority. */
export function isApprovalTimeout(block: ToolBlock): boolean {
  if (!block.toolError || !block.toolResult || block.toolResult.length > 64 * 1024) return false;
  try {
    const parsed = ToolFailureSchema.safeParse(JSON.parse(block.toolResult).failure);
    return (
      parsed.success &&
      parsed.data.code === 'approval_expired' &&
      parsed.data.effectStatus === 'not_started'
    );
  } catch {
    return false;
  } // Plain-text tool results are expected.
}

export function getToolStatus(block: ToolBlock) {
  const done =
    block.toolResult !== undefined ||
    (block.toolResultImages !== undefined && block.toolResultImages.length > 0);
  const interrupted = !done && block.toolInterrupted === true;
  return {
    done,
    hasError: block.toolError === true,
    interrupted,
    running: !done && !interrupted,
  };
}
