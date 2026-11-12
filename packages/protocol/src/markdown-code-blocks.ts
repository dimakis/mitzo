import { markdownParser } from './markdown-parser.js';

type Node = {
  type: string;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

/** Remove parsed code blocks while preserving the surrounding Markdown verbatim. */
export function stripMarkdownCodeBlocks(text: string): string {
  // Most title inputs are plain prose; code requires fence markers or indentation.
  if (
    !text.includes('```') &&
    !text.includes('~~~') &&
    !text.includes('    ') &&
    !text.includes('\t')
  )
    return text;
  const pending: Node[] = [markdownParser.parse(text)];
  const ranges: Array<{ start: number; end: number }> = [];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === 'code') {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (typeof start === 'number' && typeof end === 'number') ranges.push({ start, end });
    } else {
      for (const child of node.children ?? []) pending.push(child);
    }
  }
  if (!ranges.length) return text;
  const parts: string[] = [];
  let cursor = 0;
  for (const { start, end } of ranges.sort((a, b) => a.start - b.start)) {
    parts.push(text.slice(cursor, start), '\n');
    cursor = end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}
