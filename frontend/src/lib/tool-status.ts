import type { FinishedBlock, StreamingBlock } from '../types/chat';

export type ToolBlock = FinishedBlock | StreamingBlock;

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
