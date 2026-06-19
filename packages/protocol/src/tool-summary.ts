import { TOOL_SUMMARY_MAX_CHARS, RAW_INPUT_MAX_CHARS } from './constants.js';
import type { RawToolInput } from './types.js';
import { languageFromPath } from './language.js';

export function getRawInput(
  toolName: string,
  input: Record<string, unknown>,
): RawToolInput | undefined {
  switch (toolName) {
    case 'Read': {
      const path = String(input.file_path || '');
      return {
        type: 'read',
        path,
        language: languageFromPath(path),
      };
    }
    case 'Write': {
      const path = String(input.file_path || '');
      return {
        type: 'write',
        path,
        contents: String(input.content || '').slice(0, RAW_INPUT_MAX_CHARS),
        language: languageFromPath(path),
      };
    }
    case 'Edit':
    case 'StrReplace': {
      const path = String(input.file_path || '');
      return {
        type: 'diff',
        path,
        old_string: String(input.old_string || '').slice(0, RAW_INPUT_MAX_CHARS),
        new_string: String(input.new_string || '').slice(0, RAW_INPUT_MAX_CHARS),
        language: languageFromPath(path),
      };
    }
    case 'Bash':
    case 'Shell':
      return {
        type: 'command',
        command: String(input.command || ''),
        language: 'bash',
      };
    case 'Agent': {
      const desc = String(input.description || '');
      const stype = String(input.subagent_type || '');
      const prompt = String(input.prompt || '');
      return {
        type: 'agent' as const,
        ...(desc && { description: desc.slice(0, TOOL_SUMMARY_MAX_CHARS) }),
        ...(stype && { subagent_type: stype.slice(0, TOOL_SUMMARY_MAX_CHARS) }),
        ...(prompt && { prompt: prompt.slice(0, RAW_INPUT_MAX_CHARS) }),
      };
    }
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
    case 'Agent': {
      const desc = String(input.description || '').slice(0, TOOL_SUMMARY_MAX_CHARS);
      const stype = String(input.subagent_type || '').slice(0, TOOL_SUMMARY_MAX_CHARS);
      if (stype && desc) return `${stype} · ${desc}`.slice(0, TOOL_SUMMARY_MAX_CHARS);
      return desc || stype || 'subagent';
    }
    default:
      return JSON.stringify(input).slice(0, TOOL_SUMMARY_MAX_CHARS);
  }
}
