import { TOOL_SUMMARY_MAX_CHARS, RAW_INPUT_MAX_CHARS } from './constants.js';
import type { RawToolInput } from './types.js';

export function getRawInput(
  toolName: string,
  input: Record<string, unknown>,
): RawToolInput | undefined {
  switch (toolName) {
    case 'Write':
      return {
        type: 'write',
        path: String(input.file_path || ''),
        contents: String(input.content || '').slice(0, RAW_INPUT_MAX_CHARS),
      };
    case 'Edit':
    case 'StrReplace':
      return {
        type: 'diff',
        path: String(input.file_path || ''),
        old_string: String(input.old_string || '').slice(0, RAW_INPUT_MAX_CHARS),
        new_string: String(input.new_string || '').slice(0, RAW_INPUT_MAX_CHARS),
      };
    case 'Bash':
    case 'Shell':
      return {
        type: 'command',
        command: String(input.command || ''),
      };
    default:
      return undefined;
  }
}

export function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Read':
      return `${input.file_path || ''}`;
    case 'Write':
      return `${input.file_path || ''} (${String(input.content || '').length} chars)`;
    case 'Edit':
    case 'StrReplace':
      return `${input.file_path || ''}`;
    case 'Bash':
      return `${String(input.command || '').slice(0, TOOL_SUMMARY_MAX_CHARS)}`;
    case 'Glob':
      return `${input.pattern || ''} in ${input.path || 'workspace'}`;
    case 'Grep':
      return `/${input.pattern || ''}/ in ${input.path || 'workspace'}`;
    case 'WebSearch':
      return `${input.search_term || ''}`;
    case 'WebFetch':
      return `${input.url || ''}`;
    case 'mcp__task-board__TaskSet':
      return `${(input.tasks as unknown[])?.length ?? 0} subtasks`;
    case 'mcp__task-board__TaskComplete':
      return `${String(input.summary || '').slice(0, 60)}`;
    case 'mcp__task-board__TaskStatus':
      return 'get status';
    case 'mcp__task-board__TaskBlock':
      return `${String(input.reason || '').slice(0, 60)}`;
    default:
      return JSON.stringify(input).slice(0, TOOL_SUMMARY_MAX_CHARS);
  }
}
