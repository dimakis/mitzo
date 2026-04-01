import { summarizeToolInput } from './tool-summary.js';

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  content?: string | Array<{ type: string; text?: string }>;
  tool_use_id?: string;
}

interface ParsedToolCall {
  toolName: string;
  toolId: string;
  input: string;
}

interface ParsedToolResult {
  toolId: string;
  result: string;
}

interface ParsedContent {
  text: string;
  toolCalls: ParsedToolCall[];
  toolResults: ParsedToolResult[];
}

export function extractToolResultText(
  content: string | Array<{ type: string; text?: string }> | undefined,
): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const c of content) {
    if (c.type === 'text' && c.text) text += c.text;
  }
  return text;
}

export function parseContentBlocks(blocks: ContentBlock[]): ParsedContent {
  let text = '';
  const toolCalls: ParsedToolCall[] = [];
  const toolResults: ParsedToolResult[] = [];

  for (const block of blocks) {
    if (block.type === 'text' && block.text) {
      text += block.text;
    } else if (block.type === 'tool_use' && block.name) {
      toolCalls.push({
        toolName: block.name,
        toolId: block.id || '',
        input: summarizeToolInput(block.name, (block.input || {}) as Record<string, unknown>),
      });
    } else if (block.type === 'tool_result') {
      const rt = extractToolResultText(block.content);
      toolResults.push({
        toolId: block.tool_use_id || '',
        result: rt.slice(0, 10_000),
      });
    }
  }

  return { text, toolCalls, toolResults };
}
