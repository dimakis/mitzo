import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

export interface MorningBriefingSummary {
  filename: string;
  path: string;
  date: string;
  generatedAt: string;
}

const MORNING_BRIEFING = /^morning_(\d{4}-\d{2}-\d{2})_(\d{4})\.md$/;

/**
 * Returns the most recently generated morning briefing for a calendar day.
 * Briefings are produced outside Mitzo by both the scheduled job and chat
 * sessions, so the filesystem is the shared source of truth.
 */
export function getLatestMorningBriefing(
  repoPath: string,
  date: string,
): MorningBriefingSummary | null {
  const briefingsPath = join(repoPath, 'command_center', 'briefings');
  if (!existsSync(briefingsPath)) return null;

  const candidates = readdirSync(briefingsPath)
    .map((filename) => {
      const match = MORNING_BRIEFING.exec(filename);
      if (!match || match[1] !== date) return null;
      const path = join(briefingsPath, filename);
      const stat = statSync(path);
      if (!stat.isFile()) return null;
      return { filename, path, date: match[1], generatedAt: stat.mtime.toISOString() };
    })
    .filter((briefing): briefing is MorningBriefingSummary => briefing !== null);

  candidates.sort((a, b) => b.filename.localeCompare(a.filename));
  return candidates[0] ?? null;
}
