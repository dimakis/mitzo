import type { TodoItem } from '../types/todo';

export function sourceIcon(type: string): string {
  switch (type) {
    case 'github':
      return 'GH';
    case 'jira':
      return 'JR';
    case 'gmail':
      return 'GM';
    case 'gdocs':
      return 'GD';
    default:
      return type.slice(0, 2).toUpperCase();
  }
}

export function buildPrompt(item: TodoItem): string {
  const hints = item.contextHints;
  const lines: string[] = [`I want to work on this:`, '', `**${item.summary}**`, ''];

  if (item.sources[0]?.url) {
    lines.push(`Source: ${item.sources[0].url}`);
  }
  if (item.sources[0]?.snippet) {
    lines.push('', item.sources[0].snippet);
  }

  const context: string[] = [];
  if (hints.repos.length) context.push(`Repos: ${hints.repos.join(', ')}`);
  if (hints.issues.length) context.push(`Issues: ${hints.issues.join(', ')}`);
  if (hints.paths.length) context.push(`Files: ${hints.paths.join(', ')}`);
  if (hints.jiraKeys.length) context.push(`Jira: ${hints.jiraKeys.join(', ')}`);
  if (hints.keywords.length) context.push(`Keywords: ${hints.keywords.join(', ')}`);

  if (context.length) {
    lines.push('', 'Context:', ...context.map((c) => `- ${c}`));
  }

  if (hints.taskHint) {
    lines.push('', hints.taskHint);
  }

  lines.push('', 'Start by reading the relevant code and giving me a brief assessment.');

  return lines.join('\n');
}
