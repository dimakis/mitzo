import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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

  it('ignores unrelated files and returns null when today has no briefing', () => {
    save('morning_2026-09-09_0830.md');
    save('weekly_2026-09-10_0830.md');
    save('morning_2026-09-10_draft.md');

    expect(getLatestMorningBriefing(repoPath, '2026-09-10')).toBeNull();
  });
});
