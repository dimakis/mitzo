import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  realpathSync,
  readdirSync,
  statSync,
} from 'fs';
import { join, resolve } from 'path';
import { createHash } from 'node:crypto';
import type { BriefingSnapshot } from '@mitzo/protocol';
import { validDate } from './home-store.js';
import { readBoundedFile } from './bounded-file-read.js';
import { isPrivateCodexPath } from './codex-private-path.js';

export interface MorningBriefingSummary {
  filename: string;
  path: string;
  date: string;
  generatedAt: string;
}

const MORNING_BRIEFING = /^morning_(\d{4}-\d{2}-\d{2})_(\d{4})\.md$/;
const LEGACY_MORNING_BRIEFING = /^(\d{4}-\d{2}-\d{2})\.md$/;

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
  if (isPrivateCodexPath(briefingsPath)) throw new Error('Briefing directory is private');
  if (!existsSync(briefingsPath)) return null;

  const candidates = readdirSync(briefingsPath)
    .map((filename) => {
      const match = MORNING_BRIEFING.exec(filename) ?? LEGACY_MORNING_BRIEFING.exec(filename);
      if (!match || match[1] !== date) return null;
      const path = join(briefingsPath, filename);
      if (isPrivateCodexPath(path)) return null;
      const stat = statSync(path);
      if (!stat.isFile()) return null;
      return { filename, path, date: match[1], generatedAt: stat.mtime.toISOString() };
    })
    .filter((briefing): briefing is MorningBriefingSummary => briefing !== null);

  candidates.sort(
    (a, b) =>
      Date.parse(b.generatedAt) - Date.parse(a.generatedAt) || b.filename.localeCompare(a.filename),
  );
  return candidates[0] ?? null;
}

/** Read a dated, bounded saved report. Opening it does not generate a new briefing. */
export function readMorningBriefing(repoPath: string, date: string): BriefingSnapshot | null {
  if (!validDate(date)) throw new Error('Invalid briefing date');
  const canonicalRoot = realpathSync(repoPath);
  const directory = resolve(canonicalRoot, 'command_center', 'briefings');
  if (!existsSync(directory)) return null;
  if (realpathSync(directory) !== directory)
    throw new Error('Briefing directory must not be a symlink');
  const latest = getLatestMorningBriefing(canonicalRoot, date);
  if (!latest) return null;
  return readMorningBriefingSnapshot(latest);
}

/** Read the exact selected report, including selections from an enrolled runtime. */
export function readMorningBriefingSnapshot(latest: MorningBriefingSummary): BriefingSnapshot {
  if (isPrivateCodexPath(latest.path)) throw new Error('Briefing artifact is private');
  const fd = openSync(latest.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024)
      throw new Error('Briefing is unavailable or too large');
    const bytes = readBoundedFile(fd, 2 * 1024 * 1024);
    // Preserve a BOM as content so UTF-8 re-encoding matches the hashed saved bytes.
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return {
      ...latest,
      generatedAt: stat.mtime.toISOString(),
      revision: createHash('sha256').update(bytes).digest('hex'),
      content,
    };
  } finally {
    closeSync(fd);
  }
}
