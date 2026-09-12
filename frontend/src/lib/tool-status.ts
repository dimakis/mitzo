import type { FinishedBlock, StreamingBlock } from '../types/chat';

export type ToolBlock = FinishedBlock | StreamingBlock;

export function getToolStatus(block: ToolBlock) {
  return {
    done:
      block.toolResult !== undefined ||
      (block.toolResultImages !== undefined && block.toolResultImages.length > 0),
    hasError: block.toolError === true,
  };
}
