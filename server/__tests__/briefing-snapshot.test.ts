import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readMorningBriefing } from '../briefings.js';
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mitzo-briefing-snapshot-'));
  mkdirSync(join(root, 'command_center/briefings'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('returns the entire saved report with a stable revision rather than regenerated content', () => {
  const content =
    '# Morning Briefing\n\n## Notices\nAll notices\n\n## 09:00 — Large meeting\n### Active Jira\nAll participant context';
  const path = join(root, 'command_center/briefings/morning_2026-10-09_0700.md');
  writeFileSync(path, content);
  const snapshot = readMorningBriefing(root, '2026-10-09');
  expect(snapshot).toMatchObject({ date: '2026-10-09', content });
  expect(snapshot?.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(readMorningBriefing(root, '2026-10-09')?.revision).toBe(snapshot?.revision);
  writeFileSync(path, content + '\nUpdated');
  expect(readMorningBriefing(root, '2026-10-09')?.revision).not.toBe(snapshot?.revision);
  expect(() => readMorningBriefing(root, '../secrets')).toThrow();
});

it('does not read symlinks or oversized reports outside the briefing boundary', () => {
  const outside = join(root, 'private.md');
  writeFileSync(outside, 'private');
  symlinkSync(outside, join(root, 'command_center/briefings/morning_2026-10-09_0700.md'));
  expect(() => readMorningBriefing(root, '2026-10-09')).toThrow();
});
