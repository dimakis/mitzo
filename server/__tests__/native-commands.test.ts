import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { NativeCommandRegistry } from '../native-commands.js';
import { SkillRegistry } from '../skills.js';

function writeSkill(
  dir: string,
  name: string,
  frontmatter: Record<string, unknown>,
  body = 'Skill body',
): void {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  const yaml = Object.entries(frontmatter)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}:\n${v.map((i) => `  - ${i}`).join('\n')}`;
      return `${k}: ${JSON.stringify(v)}`;
    })
    .join('\n');
  writeFileSync(join(skillDir, 'SKILL.md'), `---\n${yaml}\n---\n\n${body}`);
}

describe('NativeCommandRegistry', () => {
  let tempDirs: string[];
  let registry: NativeCommandRegistry;

  beforeEach(() => {
    tempDirs = [];
    registry = new NativeCommandRegistry();
  });

  afterEach(() => {
    for (const d of tempDirs) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  function createTempDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'mitzo-native-test-'));
    tempDirs.push(d);
    return d;
  }

  it('has /skills registered by default', () => {
    expect(registry.has('skills')).toBe(true);
  });

  it('returns the set of registered native names', () => {
    const names = registry.names();
    expect(names.has('skills')).toBe(true);
  });

  describe('/skills command', () => {
    it('executes and lists available skills', () => {
      const dir = createTempDir();
      const skillsDir = join(dir, 'skills');
      writeSkill(skillsDir, 'deploy', { description: 'Deploy the app' });
      writeSkill(skillsDir, 'review', { description: 'Review code' });

      const skillRegistry = new SkillRegistry({ bundledDir: skillsDir });
      const result = registry.execute('skills', '', skillRegistry);

      expect(result).toBeDefined();
      expect(result!.content).toContain('deploy');
      expect(result!.content).toContain('review');
      expect(result!.command).toBe('skills');
    });

    it('shows details for a specific skill name', () => {
      const dir = createTempDir();
      const skillsDir = join(dir, 'skills');
      writeSkill(skillsDir, 'deploy', {
        description: 'Deploy the app',
        'allowed-tools': ['Bash', 'Read'],
      });

      const skillRegistry = new SkillRegistry({ bundledDir: skillsDir });
      const result = registry.execute('skills', 'deploy', skillRegistry);

      expect(result).toBeDefined();
      expect(result!.content).toContain('deploy');
      expect(result!.content).toContain('Deploy the app');
    });

    it('handles empty skill registry', () => {
      const skillRegistry = new SkillRegistry({});
      const result = registry.execute('skills', '', skillRegistry);

      expect(result).toBeDefined();
      expect(result!.content).toContain('No skills');
    });

    it('handles unknown skill name lookup', () => {
      const skillRegistry = new SkillRegistry({});
      const result = registry.execute('skills', 'nonexistent', skillRegistry);

      expect(result).toBeDefined();
      expect(result!.content).toContain('not found');
    });

    it('does not hit the model path', () => {
      const skillRegistry = new SkillRegistry({});
      const result = registry.execute('skills', '', skillRegistry);

      // Result is a NativeCommandResult, not a prompt — it's rendered directly
      expect(result).toBeDefined();
      expect(typeof result!.content).toBe('string');
    });
  });

  it('returns undefined for unknown native commands', () => {
    const skillRegistry = new SkillRegistry({});
    const result = registry.execute('unknown', '', skillRegistry);
    expect(result).toBeUndefined();
  });
});
