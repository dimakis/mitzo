import { TOOL_SUMMARY_MAX_CHARS, RAW_INPUT_MAX_CHARS } from './constants.js';

export interface RawToolInput {
  type: 'write' | 'diff' | 'command';
  path?: string;
  contents?: string;
  old_string?: string;
  new_string?: string;
  command?: string;
}

export function getRawInput(
  toolName: string,
  input: Record<string, unknown>,
): RawToolInput | undefined {
  switch (toolName) {
    case 'Write':
      return {
        type: 'write',
        path: String(input.path || ''),
        contents: String(input.contents || '').slice(0, RAW_INPUT_MAX_CHARS),
      };
    case 'Edit':
    case 'StrReplace':
      return {
        type: 'diff',
        path: String(input.path || ''),
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
      return `${input.path || ''}`;
    case 'Write':
      return `${input.path || ''} (${String(input.contents || '').length} chars)`;
    case 'Edit':
    case 'StrReplace':
      return `${input.path || ''}`;
    case 'Bash':
      return `${String(input.command || '').slice(0, TOOL_SUMMARY_MAX_CHARS)}`;
    case 'Glob':
      return `${input.glob_pattern || ''} in ${input.target_directory || 'workspace'}`;
    case 'Grep':
      return `/${input.pattern || ''}/ in ${input.path || 'workspace'}`;
    case 'WebSearch':
      return `${input.search_term || ''}`;
    case 'WebFetch':
      return `${input.url || ''}`;
    default:
      return JSON.stringify(input).slice(0, TOOL_SUMMARY_MAX_CHARS);
  }
}
