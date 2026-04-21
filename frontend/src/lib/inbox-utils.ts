interface InboxItem {
  filename: string;
  agent: string;
  title: string;
  tags: string[];
  timestamp: string;
  preview: string;
}

/** Strip YAML frontmatter from inbox item content. */
export function stripFrontmatter(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return match ? match[1].trim() : content;
}

/** Build the context string shown in the ContextBlock bubble. */
export function buildInboxContext(item: InboxItem, body: string): string {
  const lines: string[] = [];
  lines.push(`Agent: ${item.agent}`);
  lines.push(`Title: ${item.title}`);
  if (item.tags.length) lines.push(`Tags: ${item.tags.join(', ')}`);
  if (item.timestamp) lines.push(`Date: ${new Date(item.timestamp).toLocaleDateString()}`);
  lines.push('');
  lines.push(stripFrontmatter(body));
  return lines.join('\n');
}

/** Build the prompt sent to the agent for an inbox item session. */
export function buildInboxPrompt(item: InboxItem, body: string): string {
  const lines: string[] = [];
  lines.push(`I want to work on this inbox item:`);
  lines.push('');
  lines.push(`**${item.title}** (from ${item.agent})`);
  lines.push('');
  lines.push(stripFrontmatter(body));
  lines.push('');
  lines.push('Start by reading the relevant context and giving me a brief assessment.');
  return lines.join('\n');
}
