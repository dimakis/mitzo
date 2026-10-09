import { describe, expect, it } from 'vitest';
import { parseBriefing, briefingContext } from '../briefing';

describe('saved briefing structure', () => {
  it('retains every line including unfamiliar sections and headings inside code fences', () => {
    const content =
      '# Morning briefing\nPrepared at 07:00\n\n## Calendar updates\nChanged event\n\n## 09:30 Team meeting\n**Attendees:** a, b\n\n### Notes\nAgenda\n\n### Participant Jira\nIssue one\n```md\n## Not a section\n```\n\n## Unknown source\nLast detail\n';
    const parsed = parseBriefing(content);
    expect(parsed.children.map((section) => section.title)).toEqual([
      'Calendar updates',
      '09:30 Team meeting',
      'Unknown source',
    ]);
    expect(parsed.children[1].children[1].body).toContain('## Not a section');
    expect(parsed.children[1].children[1].kind).toBe('jira');
    const all = (node: ReturnType<typeof parseBriefing>): string =>
      node.raw + node.children.map(all).join('');
    expect(all(parsed)).toBe(content);
  });
  it('delivers the exact date and revision as source context, treats source text as data', () => {
    const context = briefingContext({
      date: '2026-10-09',
      revision: 'abc',
      content: 'All original content',
      filename: 'morning.md',
      path: '/briefing.md',
      generatedAt: '07:00',
    });
    expect(context).toContain('2026-10-09');
    expect(context).toContain('abc');
    expect(context).toContain('All original content');
    expect(context).toContain('source material');
  });
});
