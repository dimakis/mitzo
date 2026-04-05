import { describe, it, expect } from 'vitest';
import { statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SkillRegistry, SKILL_SIZE_LIMIT } from '../skills.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, '..', '..', 'skills');

describe('bundled skills', () => {
  const registry = new SkillRegistry({ bundledDir: SKILLS_DIR });
  const skills = registry.list();

  it('discovers all three bundled skills', () => {
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(['pr-review', 'risk-scan', 'simplify']);
  });

  it('has unique names', () => {
    const names = skills.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('all skills have descriptions', () => {
    for (const skill of skills) {
      expect(skill.description).toBeTruthy();
      expect(skill.description.length).toBeGreaterThan(5);
    }
  });

  it('all skills have concise descriptions (under 100 chars)', () => {
    for (const skill of skills) {
      expect(skill.description.length).toBeLessThan(100);
    }
  });

  it('no bundled skill includes Write or Edit in allowed-tools', () => {
    for (const skill of skills) {
      if (skill.allowedTools) {
        expect(skill.allowedTools).not.toContain('Write');
        expect(skill.allowedTools).not.toContain('Edit');
      }
    }
  });

  it('each bundled skill body contains an approval gate instruction', () => {
    for (const skill of skills) {
      const body = registry.getBody(skill.name);
      expect(body).toBeDefined();
      // Check for approval gate language
      const hasGate =
        body!.toLowerCase().includes('approval') ||
        body!.toLowerCase().includes('wait for') ||
        body!.toLowerCase().includes('present') ||
        body!.toLowerCase().includes('before making changes') ||
        body!.toLowerCase().includes('do not modify');
      expect(hasGate).toBe(true);
    }
  });

  it('all SKILL.md files are under the size limit', () => {
    for (const skill of skills) {
      const stat = statSync(skill.filePath);
      expect(stat.size).toBeLessThan(SKILL_SIZE_LIMIT);
    }
  });

  it('/simplify has analysis-only allowed-tools', () => {
    const simplify = skills.find((s) => s.name === 'simplify');
    expect(simplify).toBeDefined();
    expect(simplify!.allowedTools).toBeDefined();
    expect(simplify!.allowedTools).not.toContain('Write');
    expect(simplify!.allowedTools).not.toContain('Edit');
    expect(simplify!.allowedTools).not.toContain('Bash');
  });

  it('/risk-scan has analysis-only allowed-tools', () => {
    const riskScan = skills.find((s) => s.name === 'risk-scan');
    expect(riskScan).toBeDefined();
    expect(riskScan!.allowedTools).toBeDefined();
    expect(riskScan!.allowedTools).not.toContain('Write');
    expect(riskScan!.allowedTools).not.toContain('Edit');
  });

  it('/pr-review includes Bash for git diff access', () => {
    const prReview = skills.find((s) => s.name === 'pr-review');
    expect(prReview).toBeDefined();
    expect(prReview!.allowedTools).toBeDefined();
    expect(prReview!.allowedTools).toContain('Bash');
    // But not Write/Edit — analysis first
    expect(prReview!.allowedTools).not.toContain('Write');
    expect(prReview!.allowedTools).not.toContain('Edit');
  });

  it('all bundled skills are scoped as bundled', () => {
    for (const skill of skills) {
      expect(skill.scope).toBe('bundled');
    }
  });
});
