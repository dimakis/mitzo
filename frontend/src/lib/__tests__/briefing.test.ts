import { describe, expect, it } from 'vitest';
import { parseBriefing, briefingSource } from '../briefing';

describe('saved briefing structure', () => {
  it('treats timed manager meetings as meetings and the notice block as collapsible calendar context', () => {
    const report = parseBriefing(
      '## Notices\n### Manager actions\nNotice\n## 15:30 — Platform Managers Sync\nAgenda',
    );
    expect(report.children[0].kind).toBe('calendar');
    expect(report.children[1].kind).toBe('meeting');
  });
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
    const context = briefingSource({
      date: '2026-10-09',
      revision: 'abc',
      content: 'All original content',
      filename: 'morning.md',
      path: '/briefing.md',
      generatedAt: '07:00',
    });
    expect(context).toEqual({
      kind: 'briefing',
      date: '2026-10-09',
      revision: 'abc',
      content: 'All original content',
    });
  });
});
