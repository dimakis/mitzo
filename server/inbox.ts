import { readdirSync, readFileSync, renameSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join, basename } from 'path';

export interface InboxItemSummary {
  filename: string;
  agent: string;
  title: string;
  tags: string[];
  timestamp: string;
  preview: string;
}

function isSafeFilename(name: string): boolean {
  const base = basename(name);
  return base === name && !name.includes('..') && name.endsWith('.md');
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };

  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const sep = line.indexOf(':');
    if (sep > 0) {
      meta[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
    }
  }
  return { meta, body: match[2] };
}

function parseTags(raw: string | undefined): string[] {
  if (!raw) return [];
  const inner = raw.replace(/^\[/, '').replace(/\]$/, '');
  if (!inner.trim()) return [];
  return inner
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

function extractTitle(body: string): string {
  const match = body.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : '';
}

function extractPreview(body: string, maxLen = 150): string {
  // Get text after the title line, strip markdown formatting
  const lines = body.split('\n');
  const titleIdx = lines.findIndex((l) => l.startsWith('# '));
  const afterTitle = lines
    .slice(titleIdx + 1)
    .join('\n')
    .trim();
  const plain = afterTitle.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
  return plain.length > maxLen ? plain.slice(0, maxLen) : plain;
}

export function listInboxItems(inboxPath: string): InboxItemSummary[] {
  let files: string[];
  try {
    files = readdirSync(inboxPath).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }

  const items: InboxItemSummary[] = [];
  for (const filename of files) {
    try {
      const raw = readFileSync(join(inboxPath, filename), 'utf-8');
      const { meta, body } = parseFrontmatter(raw);
      items.push({
        filename,
        agent: meta.agent || 'unknown',
        title: extractTitle(body),
        tags: parseTags(meta.tags),
        timestamp: meta.timestamp || '',
        preview: extractPreview(body),
      });
    } catch {
      // Skip unreadable files
    }
  }

  // Sort newest first (filenames are timestamped)
  items.sort((a, b) => b.filename.localeCompare(a.filename));
  return items;
}

export function readInboxItem(inboxPath: string, filename: string): string | null {
  if (!isSafeFilename(filename)) return null;
  try {
    return readFileSync(join(inboxPath, filename), 'utf-8');
  } catch {
    return null;
  }
}

export function approveInboxItem(inboxPath: string, filename: string): boolean {
  if (!isSafeFilename(filename)) return false;
  const src = join(inboxPath, filename);
  if (!existsSync(src)) return false;
  const archiveDir = join(inboxPath, 'archive');
  mkdirSync(archiveDir, { recursive: true });
  renameSync(src, join(archiveDir, filename));
  return true;
}

export function discardInboxItem(inboxPath: string, filename: string): boolean {
  if (!isSafeFilename(filename)) return false;
  const target = join(inboxPath, filename);
  if (!existsSync(target)) return false;
  unlinkSync(target);
  return true;
}
