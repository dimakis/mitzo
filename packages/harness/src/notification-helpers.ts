import type { SnapshotBlock } from '@mitzo/protocol';

export function extractSnippet(blocks: SnapshotBlock[], maxChars: number): string {
  // Only visible assistant prose belongs in a result preview. Empty streamed
  // blocks must not replace the written outcome with a generic completion.
  const text = blocks.findLast((b) => b.blockType === 'text' && b.content.trim())?.content ?? '';
  const content = text
    .replace(/^\s{0,3}#{1,6}\s+(.+)$/gm, '$1:')
    .replace(/^\s*(?:[-*+] |\d+\. )/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!content) return '';
  if (content.length <= maxChars) return content;
  const truncated = content.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > maxChars * 0.5 ? truncated.slice(0, lastSpace) : truncated) + '...';
}
