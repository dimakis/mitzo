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
      return `${String(input.command || '').slice(0, 200)}`;
    case 'Glob':
      return `${input.glob_pattern || ''} in ${input.target_directory || 'workspace'}`;
    case 'Grep':
      return `/${input.pattern || ''}/ in ${input.path || 'workspace'}`;
    case 'WebSearch':
      return `${input.search_term || ''}`;
    case 'WebFetch':
      return `${input.url || ''}`;
    default:
      return JSON.stringify(input).slice(0, 200);
  }
}
