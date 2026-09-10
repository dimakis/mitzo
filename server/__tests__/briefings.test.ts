import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getLatestMorningBriefing } from '../briefings.js';

let repoPath: string;

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), 'mitzo-briefings-'));
});

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true });
});

function save(filename: string, content = '# Briefing') {
  const path = join(repoPath, 'command_center', 'briefings', filename);
  mkdirSync(join(repoPath, 'command_center', 'briefings'), { recursive: true });
  writeFileSync(path, content);
  return path;
}

describe('getLatestMorningBriefing', () => {
  it('returns the latest morning briefing for the requested day', () => {
    save('morning_2026-09-10_0700.md');
    const latestPath = save('morning_2026-09-10_0830.md');
    save('morning_2026-09-09_0830.md');

    expect(getLatestMorningBriefing(repoPath, '2026-09-10')).toMatchObject({
      filename: 'morning_2026-09-10_0830.md',
      path: latestPath,
      date: '2026-09-10',
    });
  });

  it('supports the legacy scheduled briefing filename', () => {
    const path = save('2026-09-10.md');

    expect(getLatestMorningBriefing(repoPath, '2026-09-10')).toMatchObject({
      filename: '2026-09-10.md',
      path,
      date: '2026-09-10',
    });
  });

  it('chooses the most recently generated report across filename formats', () => {
    const chatPath = save('morning_2026-09-10_0830.md');
    const scheduledPath = save('2026-09-10.md');
    utimesSync(chatPath, new Date('2026-09-10T08:30:00Z'), new Date('2026-09-10T08:30:00Z'));
    utimesSync(scheduledPath, new Date('2026-09-10T09:00:00Z'), new Date('2026-09-10T09:00:00Z'));

    expect(getLatestMorningBriefing(repoPath, '2026-09-10')).toMatchObject({
      filename: '2026-09-10.md',
      path: scheduledPath,
    });
  });

  it('ignores unrelated files and returns null when today has no briefing', () => {
    save('morning_2026-09-09_0830.md');
    save('weekly_2026-09-10_0830.md');
    save('morning_2026-09-10_draft.md');

    expect(getLatestMorningBriefing(repoPath, '2026-09-10')).toBeNull();
  });
});
