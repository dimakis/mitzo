import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SkillRegistry, SKILL_SIZE_LIMIT } from '../skills.js';

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
  const filePath = join(skillDir, 'SKILL.md');
  writeFileSync(filePath, content);
  return skillDir;
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mitzo-skills-test-'));
}

// --- Tests ---

describe('SkillRegistry', () => {
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

  describe('metadata discovery', () => {
    it('discovers skills from a single scope directory', () => {
      const dir = createTempDir();
      const skillsDir = join(dir, 'skills');
      writeSkill(skillsDir, 'deploy', {
        description: 'Deploy the application',
        'allowed-tools': ['Bash', 'Read'],
      });

      const registry = new SkillRegistry({
        bundledDir: skillsDir,
      });

      const skills = registry.list();
      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('deploy');
      expect(skills[0].description).toBe('Deploy the application');
      expect(skills[0].scope).toBe('bundled');
      expect(skills[0].allowedTools).toEqual(['Bash', 'Read']);
    });

    it('returns correct precedence: repo > user > bundled', () => {
      const bundledDir = createTempDir();
      const userDir = createTempDir();
      const repoDir = createTempDir();

      writeSkill(join(bundledDir, 'skills'), 'deploy', { description: 'bundled deploy' });
      writeSkill(join(userDir, 'skills'), 'deploy', { description: 'user deploy' });
      writeSkill(join(repoDir, 'skills'), 'deploy', { description: 'repo deploy' });

      const registry = new SkillRegistry({
        bundledDir: join(bundledDir, 'skills'),
        userDir: join(userDir, 'skills'),
        repoDir: join(repoDir, 'skills'),
      });

      const skills = registry.list();
      const deploy = skills.find((s) => s.name === 'deploy');
      expect(deploy).toBeDefined();
      expect(deploy!.scope).toBe('repo');
      expect(deploy!.description).toBe('repo deploy');
    });

    it('preserves collision metadata', () => {
      const bundledDir = createTempDir();
      const userDir = createTempDir();

      writeSkill(join(bundledDir, 'skills'), 'deploy', { description: 'bundled deploy' });
      writeSkill(join(userDir, 'skills'), 'deploy', { description: 'user deploy' });

      const registry = new SkillRegistry({
        bundledDir: join(bundledDir, 'skills'),
        userDir: join(userDir, 'skills'),
      });

      const skills = registry.list();
      const deploy = skills.find((s) => s.name === 'deploy');
      expect(deploy).toBeDefined();
      expect(deploy!.collisions).toBeDefined();
      expect(deploy!.collisions).toHaveLength(1);
      expect(deploy!.collisions![0].scope).toBe('bundled');
    });

    it('treats native names as reserved', () => {
      const dir = createTempDir();
      writeSkill(join(dir, 'skills'), 'skills', { description: 'rogue skills command' });

      const registry = new SkillRegistry({
        bundledDir: join(dir, 'skills'),
        nativeNames: new Set(['skills']),
      });

      const skills = registry.list();
      expect(skills.find((s) => s.name === 'skills')).toBeUndefined();
    });

    it('does not load skill body during metadata-only discovery', () => {
      const dir = createTempDir();
      const body = 'This is a long body that should not be loaded during discovery';
      writeSkill(join(dir, 'skills'), 'deploy', { description: 'Deploy' }, body);

      const registry = new SkillRegistry({
        bundledDir: join(dir, 'skills'),
      });

      const skills = registry.list();
      expect(skills[0]).not.toHaveProperty('body');
    });

    it('loads skill body on demand via getBody()', () => {
      const dir = createTempDir();
      const body = 'Deploy to $ARGUMENTS';
      writeSkill(join(dir, 'skills'), 'deploy', { description: 'Deploy' }, body);

      const registry = new SkillRegistry({
        bundledDir: join(dir, 'skills'),
      });

      const result = registry.getBody('deploy');
      expect(result).toBe(body);
    });

    it('discovers skills with no allowed-tools as unrestricted', () => {
      const dir = createTempDir();
      writeSkill(join(dir, 'skills'), 'review', { description: 'Review code' });

      const registry = new SkillRegistry({
        bundledDir: join(dir, 'skills'),
      });

      const skills = registry.list();
      expect(skills[0].allowedTools).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('handles empty skills directory gracefully', () => {
      const dir = createTempDir();
      const skillsDir = join(dir, 'skills');
      mkdirSync(skillsDir, { recursive: true });

      const registry = new SkillRegistry({
        bundledDir: skillsDir,
      });

      expect(registry.list()).toEqual([]);
    });

    it('skips directories with missing SKILL.md', () => {
      const dir = createTempDir();
      const skillsDir = join(dir, 'skills');
      mkdirSync(join(skillsDir, 'deploy'), { recursive: true });
      // No SKILL.md written

      const registry = new SkillRegistry({
        bundledDir: skillsDir,
      });

      expect(registry.list()).toEqual([]);
    });

    it('skips SKILL.md with invalid YAML frontmatter', () => {
      const dir = createTempDir();
      const skillsDir = join(dir, 'skills');
      const skillDir = join(skillsDir, 'broken');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), '---\n: invalid: yaml:\n---\n\nbody');

      const registry = new SkillRegistry({
        bundledDir: skillsDir,
      });

      expect(registry.list()).toEqual([]);
    });

    it('skips SKILL.md with no frontmatter', () => {
      const dir = createTempDir();
      const skillsDir = join(dir, 'skills');
      const skillDir = join(skillsDir, 'bare');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), 'Just some text, no frontmatter');

      const registry = new SkillRegistry({
        bundledDir: skillsDir,
      });

      expect(registry.list()).toEqual([]);
    });

    it('skips SKILL.md larger than size limit', () => {
      const dir = createTempDir();
      const skillsDir = join(dir, 'skills');
      const skillDir = join(skillsDir, 'huge');
      mkdirSync(skillDir, { recursive: true });
      const bigContent = '---\ndescription: "huge"\n---\n\n' + 'x'.repeat(SKILL_SIZE_LIMIT + 1);
      writeFileSync(join(skillDir, 'SKILL.md'), bigContent);

      const registry = new SkillRegistry({
        bundledDir: skillsDir,
      });

      expect(registry.list()).toEqual([]);
    });

    it('handles nonexistent skills directory gracefully', () => {
      const registry = new SkillRegistry({
        bundledDir: '/nonexistent/path/skills',
      });

      expect(registry.list()).toEqual([]);
    });

    it('returns undefined body for unknown skill name', () => {
      const registry = new SkillRegistry({});
      expect(registry.getBody('nonexistent')).toBeUndefined();
    });
  });

  describe('cache invalidation', () => {
    it('invalidates cache when a skill file changes', () => {
      const dir = createTempDir();
      const skillsDir = join(dir, 'skills');
      writeSkill(skillsDir, 'deploy', { description: 'v1' });

      const registry = new SkillRegistry({
        bundledDir: skillsDir,
      });

      expect(registry.list()[0].description).toBe('v1');

      // Overwrite with new content and bump mtime
      writeSkill(skillsDir, 'deploy', { description: 'v2' });

      registry.invalidate();
      expect(registry.list()[0].description).toBe('v2');
    });

    it('invalidates cache when a new skill is added', () => {
      const dir = createTempDir();
      const skillsDir = join(dir, 'skills');
      writeSkill(skillsDir, 'deploy', { description: 'Deploy' });

      const registry = new SkillRegistry({
        bundledDir: skillsDir,
      });

      expect(registry.list()).toHaveLength(1);

      writeSkill(skillsDir, 'review', { description: 'Review' });

      registry.invalidate();
      expect(registry.list()).toHaveLength(2);
    });
  });

  describe('repo root resolution', () => {
    it('uses separate cache entries for different repo dirs', () => {
      const repo1 = createTempDir();
      const repo2 = createTempDir();

      writeSkill(join(repo1, 'skills'), 'deploy', { description: 'repo1 deploy' });
      writeSkill(join(repo2, 'skills'), 'deploy', { description: 'repo2 deploy' });

      const registry1 = new SkillRegistry({
        repoDir: join(repo1, 'skills'),
      });

      const registry2 = new SkillRegistry({
        repoDir: join(repo2, 'skills'),
      });

      expect(registry1.list()[0].description).toBe('repo1 deploy');
      expect(registry2.list()[0].description).toBe('repo2 deploy');
    });
  });

  describe('multiple scopes with unique skills', () => {
    it('merges skills from all scopes', () => {
      const bundledDir = createTempDir();
      const userDir = createTempDir();
      const repoDir = createTempDir();

      writeSkill(join(bundledDir, 'skills'), 'simplify', { description: 'Simplify code' });
      writeSkill(join(userDir, 'skills'), 'my-tool', { description: 'My custom tool' });
      writeSkill(join(repoDir, 'skills'), 'deploy', { description: 'Deploy this repo' });

      const registry = new SkillRegistry({
        bundledDir: join(bundledDir, 'skills'),
        userDir: join(userDir, 'skills'),
        repoDir: join(repoDir, 'skills'),
      });

      const skills = registry.list();
      expect(skills).toHaveLength(3);

      const names = skills.map((s) => s.name).sort();
      expect(names).toEqual(['deploy', 'my-tool', 'simplify']);
    });
  });
});
