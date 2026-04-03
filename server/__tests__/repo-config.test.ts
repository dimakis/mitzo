import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { loadRepoConfig } from '../repo-config.js';

const TMP_DIR = join(import.meta.dirname, '..', '..', '.test-repo-config');

beforeEach(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('loadRepoConfig', () => {
  it('returns empty defaults when .mitzo.json does not exist', () => {
    const config = loadRepoConfig(TMP_DIR);
    expect(config.quickActions).toEqual([]);
    expect(config.venvPaths).toEqual([]);
  });

  it('parses valid .mitzo.json with quickActions and venvPaths', () => {
    const data = {
      quickActions: [{ label: 'Test', desc: 'A test action', path: '/chat', prompt: 'hello' }],
      venvPaths: ['my-project/.venv/bin'],
    };
    writeFileSync(join(TMP_DIR, '.mitzo.json'), JSON.stringify(data));

    const config = loadRepoConfig(TMP_DIR);
    expect(config.quickActions).toHaveLength(1);
    expect(config.quickActions[0].label).toBe('Test');
    expect(config.venvPaths).toEqual(['my-project/.venv/bin']);
  });

  it('resolves venvPaths relative to repoPath', () => {
    const data = { venvPaths: ['sub/.venv/bin', 'other/.venv/bin'] };
    writeFileSync(join(TMP_DIR, '.mitzo.json'), JSON.stringify(data));

    const config = loadRepoConfig(TMP_DIR);
    expect(config.resolvedVenvPaths).toEqual([
      join(TMP_DIR, 'sub/.venv/bin'),
      join(TMP_DIR, 'other/.venv/bin'),
    ]);
  });

  it('returns empty defaults for invalid JSON', () => {
    writeFileSync(join(TMP_DIR, '.mitzo.json'), '{ broken json !!!');

    const config = loadRepoConfig(TMP_DIR);
    expect(config.quickActions).toEqual([]);
    expect(config.venvPaths).toEqual([]);
  });

  it('returns empty defaults for non-object JSON', () => {
    writeFileSync(join(TMP_DIR, '.mitzo.json'), '"just a string"');

    const config = loadRepoConfig(TMP_DIR);
    expect(config.quickActions).toEqual([]);
    expect(config.venvPaths).toEqual([]);
  });

  it('ignores unknown fields gracefully', () => {
    const data = { quickActions: [], venvPaths: [], unknownField: 42 };
    writeFileSync(join(TMP_DIR, '.mitzo.json'), JSON.stringify(data));

    const config = loadRepoConfig(TMP_DIR);
    expect(config.quickActions).toEqual([]);
    expect(config.venvPaths).toEqual([]);
  });

  it('parses roots from .mitzo.json', () => {
    const data = {
      roots: [
        { label: 'Main', path: '/some/repo' },
        { label: 'Tools', path: '/some/tools' },
      ],
    };
    writeFileSync(join(TMP_DIR, '.mitzo.json'), JSON.stringify(data));

    const config = loadRepoConfig(TMP_DIR);
    expect(config.roots).toEqual([
      { label: 'Main', path: '/some/repo' },
      { label: 'Tools', path: '/some/tools' },
    ]);
  });

  it('returns empty roots when not specified', () => {
    const data = { quickActions: [] };
    writeFileSync(join(TMP_DIR, '.mitzo.json'), JSON.stringify(data));

    const config = loadRepoConfig(TMP_DIR);
    expect(config.roots).toEqual([]);
  });

  it('filters out invalid root entries', () => {
    const data = {
      roots: [
        { label: 'Valid', path: '/ok' },
        { label: 'No path' },
        { path: '/no-label' },
        'not an object',
        { label: 'Also Valid', path: '/also/ok' },
      ],
    };
    writeFileSync(join(TMP_DIR, '.mitzo.json'), JSON.stringify(data));

    const config = loadRepoConfig(TMP_DIR);
    expect(config.roots).toHaveLength(2);
    expect(config.roots[0].label).toBe('Valid');
    expect(config.roots[1].label).toBe('Also Valid');
  });

  it('filters out quickActions with missing required fields', () => {
    const data = {
      quickActions: [
        { label: 'Valid', desc: 'ok' },
        { desc: 'no label' },
        { label: 'No desc' },
        { label: 'Also Valid', desc: 'fine', prompt: 'hi' },
      ],
    };
    writeFileSync(join(TMP_DIR, '.mitzo.json'), JSON.stringify(data));

    const config = loadRepoConfig(TMP_DIR);
    expect(config.quickActions).toHaveLength(2);
    expect(config.quickActions[0].label).toBe('Valid');
    expect(config.quickActions[1].label).toBe('Also Valid');
  });
});
