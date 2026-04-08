import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, readdirSync } from 'fs';
import {
  listInboxItems,
  readInboxItem,
  approveInboxItem,
  discardInboxItem,
  createInboxItem,
} from '../inbox.js';

const TMP_DIR = join(import.meta.dirname, '..', '..', '.test-inbox');

const SAMPLE_ITEM = `---
agent: troubadour
timestamp: 2026-04-03T15:41:49.322523
status: pending
tags: [cross-spoke, okrs, team_home]
---

# Connection: okrs/ → team_home/

**okrs/** and **team_home/** share 114 terms.

**Score:** 0.28

**Suggestion:** Review these files for connections.
`;

const SAMPLE_ITEM_NO_TAGS = `---
agent: health_monitor
timestamp: 2026-04-03T22:00:00
status: pending
---

# Boot context over budget

Boot context is at 720 lines (threshold: 700).
`;

beforeEach(() => {
  mkdirSync(join(TMP_DIR, 'archive'), { recursive: true });
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('listInboxItems', () => {
  it('returns empty array when directory is empty', () => {
    const items = listInboxItems(TMP_DIR);
    expect(items).toEqual([]);
  });

  it('returns empty array when directory does not exist', () => {
    const items = listInboxItems('/tmp/nonexistent-inbox-path');
    expect(items).toEqual([]);
  });

  it('parses inbox items with frontmatter', () => {
    writeFileSync(join(TMP_DIR, '20260403_154149_01_troubadour.md'), SAMPLE_ITEM);

    const items = listInboxItems(TMP_DIR);
    expect(items).toHaveLength(1);
    expect(items[0].filename).toBe('20260403_154149_01_troubadour.md');
    expect(items[0].agent).toBe('troubadour');
    expect(items[0].title).toBe('Connection: okrs/ → team_home/');
    expect(items[0].tags).toEqual(['cross-spoke', 'okrs', 'team_home']);
    expect(items[0].timestamp).toBe('2026-04-03T15:41:49.322523');
  });

  it('handles items without tags', () => {
    writeFileSync(join(TMP_DIR, '20260403_220000_01_health.md'), SAMPLE_ITEM_NO_TAGS);

    const items = listInboxItems(TMP_DIR);
    expect(items).toHaveLength(1);
    expect(items[0].agent).toBe('health_monitor');
    expect(items[0].tags).toEqual([]);
    expect(items[0].title).toBe('Boot context over budget');
  });

  it('generates preview from body text', () => {
    writeFileSync(join(TMP_DIR, '20260403_154149_01_troubadour.md'), SAMPLE_ITEM);

    const items = listInboxItems(TMP_DIR);
    expect(items[0].preview).toContain('okrs/');
    expect(items[0].preview.length).toBeLessThanOrEqual(150);
  });

  it('ignores non-md files and archive directory', () => {
    writeFileSync(join(TMP_DIR, '20260403_154149_01_troubadour.md'), SAMPLE_ITEM);
    writeFileSync(join(TMP_DIR, 'readme.txt'), 'ignore me');
    writeFileSync(join(TMP_DIR, 'archive', 'old.md'), SAMPLE_ITEM);

    const items = listInboxItems(TMP_DIR);
    expect(items).toHaveLength(1);
  });

  it('sorts items by filename (newest first)', () => {
    writeFileSync(join(TMP_DIR, '20260401_000000_01_a.md'), SAMPLE_ITEM);
    writeFileSync(join(TMP_DIR, '20260403_154149_01_b.md'), SAMPLE_ITEM);

    const items = listInboxItems(TMP_DIR);
    expect(items[0].filename).toBe('20260403_154149_01_b.md');
    expect(items[1].filename).toBe('20260401_000000_01_a.md');
  });
});

describe('readInboxItem', () => {
  it('returns full markdown content', () => {
    writeFileSync(join(TMP_DIR, '20260403_154149_01_troubadour.md'), SAMPLE_ITEM);

    const content = readInboxItem(TMP_DIR, '20260403_154149_01_troubadour.md');
    expect(content).toBe(SAMPLE_ITEM);
  });

  it('returns null for nonexistent file', () => {
    const content = readInboxItem(TMP_DIR, 'nonexistent.md');
    expect(content).toBeNull();
  });

  it('rejects path traversal attempts', () => {
    const content = readInboxItem(TMP_DIR, '../../../etc/passwd');
    expect(content).toBeNull();
  });
});

describe('approveInboxItem', () => {
  it('moves file to archive directory', () => {
    writeFileSync(join(TMP_DIR, '20260403_154149_01_troubadour.md'), SAMPLE_ITEM);

    const ok = approveInboxItem(TMP_DIR, '20260403_154149_01_troubadour.md');
    expect(ok).toBe(true);

    // File should no longer be in inbox
    const items = listInboxItems(TMP_DIR);
    expect(items).toHaveLength(0);
  });

  it('returns false for nonexistent file', () => {
    const ok = approveInboxItem(TMP_DIR, 'nonexistent.md');
    expect(ok).toBe(false);
  });
});

describe('discardInboxItem', () => {
  it('deletes the file', () => {
    writeFileSync(join(TMP_DIR, '20260403_154149_01_troubadour.md'), SAMPLE_ITEM);

    const ok = discardInboxItem(TMP_DIR, '20260403_154149_01_troubadour.md');
    expect(ok).toBe(true);

    const items = listInboxItems(TMP_DIR);
    expect(items).toHaveLength(0);
  });

  it('returns false for nonexistent file', () => {
    const ok = discardInboxItem(TMP_DIR, 'nonexistent.md');
    expect(ok).toBe(false);
  });

  it('rejects path traversal attempts', () => {
    const ok = discardInboxItem(TMP_DIR, '../../../important-file');
    expect(ok).toBe(false);
  });
});

describe('createInboxItem', () => {
  it('creates a valid inbox item file', () => {
    const item = createInboxItem(TMP_DIR, {
      source: 'test-agent',
      title: 'Test Item',
      body: 'Some body text',
      tags: ['tag1', 'tag2'],
    });

    expect(item).not.toBeNull();
    expect(item!.agent).toBe('test-agent');
    expect(item!.title).toBe('Test Item');
    expect(item!.tags).toEqual(['tag1', 'tag2']);

    // File should be listable
    const items = listInboxItems(TMP_DIR);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Test Item');
  });

  it('generates unique filenames for rapid successive calls', () => {
    const results = [];
    for (let i = 0; i < 5; i++) {
      const item = createInboxItem(TMP_DIR, {
        source: 'test-agent',
        title: `Item ${i}`,
        body: `Body ${i}`,
      });
      results.push(item);
    }

    // All should succeed
    expect(results.every((r) => r !== null)).toBe(true);

    // All filenames should be unique
    const filenames = results.map((r) => r!.filename);
    expect(new Set(filenames).size).toBe(5);

    // All files should exist
    const files = readdirSync(TMP_DIR).filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(5);
  });

  it('returns null for invalid inbox path', () => {
    // Use a path that will fail (file as directory)
    writeFileSync(join(TMP_DIR, 'not-a-dir'), 'block');
    const item = createInboxItem(join(TMP_DIR, 'not-a-dir', 'sub'), {
      source: 'test',
      title: 'Test',
      body: 'Body',
    });
    expect(item).toBeNull();
  });
});
