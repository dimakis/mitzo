import type { SnapshotBlock } from '@mitzo/protocol';

const FALLBACK = 'Agent finished its turn.';

export function extractSnippet(blocks: SnapshotBlock[], maxChars: number): string {
  const textBlocks = blocks.filter((b) => b.blockType === 'text');
  if (textBlocks.length === 0) return FALLBACK;
  const content = textBlocks[textBlocks.length - 1].content.trim();
  if (!content) return FALLBACK;
  if (content.length <= maxChars) return content;
  const truncated = content.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > maxChars * 0.5 ? truncated.slice(0, lastSpace) : truncated) + '...';
}
