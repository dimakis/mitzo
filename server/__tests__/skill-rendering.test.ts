import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SkillRegistry } from '../skills.js';
import { parseSlashCommand, resolveSlashCommand, renderSkillPrompt } from '../slash-commands.js';

// --- Helpers ---

function writeSkill(
  dir: string,
  name: string,
  frontmatter: Record<string, unknown>,
  body = 'Skill body for $ARGUMENTS',
): string {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  const yaml = Object.entries(frontmatter)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}:\n${v.map((i) => `  - ${i}`).join('\n')}`;
      return `${k}: ${JSON.stringify(v)}`;
    })
    .join('\n');
  const content = `---\n${yaml}\n---\n\n${body}`;
  writeFileSync(join(skillDir, 'SKILL.md'), content);
  return skillDir;
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mitzo-slash-test-'));
}

// --- Tests ---

describe('parseSlashCommand', () => {
  it('parses /simplify api layer into name and arguments', () => {
    const result = parseSlashCommand('/simplify api layer');
    expect(result).toEqual({ name: 'simplify', arguments: 'api layer' });
  });

  it('parses /skills deploy into name and arguments', () => {
    const result = parseSlashCommand('/skills deploy');
    expect(result).toEqual({ name: 'skills', arguments: 'deploy' });
  });

  it('parses /simplify with no arguments', () => {
    const result = parseSlashCommand('/simplify');
    expect(result).toEqual({ name: 'simplify', arguments: '' });
  });

  it('returns null for plain text', () => {
    expect(parseSlashCommand('hello world')).toBeNull();
    expect(parseSlashCommand('fix the bug')).toBeNull();
    expect(parseSlashCommand('')).toBeNull();
  });

  it('returns null for messages with slash not at start', () => {
    expect(parseSlashCommand('use /simplify here')).toBeNull();
  });

  it('returns null for bare slash', () => {
    expect(parseSlashCommand('/')).toBeNull();
    expect(parseSlashCommand('/ ')).toBeNull();
  });
});

describe('resolveSlashCommand', () => {
  let tempDirs: string[];

  beforeEach(() => {
    tempDirs = [];
  });

  afterEach(() => {
    for (const d of tempDirs) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  function createTempDir(): string {
    const d = makeTempDir();
    tempDirs.push(d);
    return d;
  }

  it('resolves a known skill to a skill result', () => {
    const dir = createTempDir();
    const skillsDir = join(dir, 'skills');
    writeSkill(skillsDir, 'simplify', { description: 'Simplify code' }, 'Simplify: $ARGUMENTS');

    const registry = new SkillRegistry({ bundledDir: skillsDir });
    const result = resolveSlashCommand('/simplify api layer', registry, new Set());

    expect(result.type).toBe('skill');
    if (result.type === 'skill') {
      expect(result.name).toBe('simplify');
      expect(result.arguments).toBe('api layer');
      expect(result.renderedPrompt).toContain('Simplify: api layer');
    }
  });

  it('resolves a native command name to a native result', () => {
    const registry = new SkillRegistry({});
    const result = resolveSlashCommand('/skills', registry, new Set(['skills']));

    expect(result.type).toBe('native');
    if (result.type === 'native') {
      expect(result.name).toBe('skills');
      expect(result.arguments).toBe('');
    }
  });

  it('resolves an unknown slash command to an error with suggestions', () => {
    const dir = createTempDir();
    const skillsDir = join(dir, 'skills');
    writeSkill(skillsDir, 'simplify', { description: 'Simplify code' });
    writeSkill(skillsDir, 'deploy', { description: 'Deploy' });

    const registry = new SkillRegistry({ bundledDir: skillsDir });
    const result = resolveSlashCommand('/simpify', registry, new Set());

    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.message).toContain('simpify');
      expect(result.suggestions).toContain('simplify');
    }
  });

  it('returns passthrough for plain text', () => {
    const registry = new SkillRegistry({});
    const result = resolveSlashCommand('hello world', registry, new Set());

    expect(result.type).toBe('passthrough');
  });

  it('includes collision info in skill result', () => {
    const dir1 = createTempDir();
    const dir2 = createTempDir();

    writeSkill(join(dir1, 'skills'), 'deploy', { description: 'user deploy' }, 'User deploy');
    writeSkill(join(dir2, 'skills'), 'deploy', { description: 'bundled deploy' }, 'Bundled deploy');

    const registry = new SkillRegistry({
      userDir: join(dir1, 'skills'),
      bundledDir: join(dir2, 'skills'),
    });

    const result = resolveSlashCommand('/deploy', registry, new Set());
    expect(result.type).toBe('skill');
    if (result.type === 'skill') {
      expect(result.collisions).toBeDefined();
      expect(result.collisions!.length).toBe(1);
    }
  });
});

describe('renderSkillPrompt', () => {
  it('substitutes $ARGUMENTS in skill body', () => {
    const result = renderSkillPrompt('Review the $ARGUMENTS for issues', 'api layer', {
      name: 'review',
      scope: 'bundled',
    });
    expect(result).toContain('Review the api layer for issues');
  });

  it('includes skill source metadata in envelope', () => {
    const result = renderSkillPrompt('Do something', 'args', {
      name: 'deploy',
      scope: 'repo',
    });
    expect(result).toContain('deploy');
    expect(result).toContain('repo');
  });

  it('handles empty arguments', () => {
    const result = renderSkillPrompt('Scan $ARGUMENTS', '', {
      name: 'scan',
      scope: 'user',
    });
    expect(result).toContain('Scan ');
  });

  it('handles body with no $ARGUMENTS token', () => {
    const result = renderSkillPrompt('Just do the thing', 'extra args', {
      name: 'simple',
      scope: 'bundled',
    });
    expect(result).toContain('Just do the thing');
  });
});
