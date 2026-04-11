import { describe, it, expect } from 'vitest';
import { statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SkillRegistry, SKILL_SIZE_LIMIT } from '../skills.js';
import { renderSkillPrompt } from '../slash-commands.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, '..', '..', 'skills');

describe('bundled skills', () => {
  const registry = new SkillRegistry({ bundledDir: SKILLS_DIR });
  const skills = registry.list();

  it('discovers all five bundled skills', () => {
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(['person', 'pr-review', 'review-response', 'risk-scan', 'simplify']);
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

  it('analysis-only bundled skills do not include Write or Edit in allowed-tools', () => {
    const analysisOnly = skills.filter((s) => s.name !== 'person');
    for (const skill of analysisOnly) {
      if (skill.allowedTools) {
        expect(skill.allowedTools).not.toContain('Write');
        expect(skill.allowedTools).not.toContain('Edit');
      }
    }
  });

  it('analysis bundled skills contain an approval gate instruction', () => {
    // Analysis skills must include BOTH "present" AND "before making changes"
    // so users always see findings before any modifications happen.
    const analysisSkills = skills.filter((s) => s.name !== 'person');
    for (const skill of analysisSkills) {
      const body = registry.getBody(skill.name)!;
      expect(body).toBeDefined();
      const lower = body.toLowerCase();
      expect(
        lower.includes('present') && lower.includes('before making changes'),
        `Skill "${skill.name}" must contain both "present" and "before making changes"`,
      ).toBe(true);
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

  it('/review-response includes Bash for gh CLI access', () => {
    const reviewResponse = skills.find((s) => s.name === 'review-response');
    expect(reviewResponse).toBeDefined();
    expect(reviewResponse!.allowedTools).toBeDefined();
    expect(reviewResponse!.allowedTools).toContain('Bash');
    expect(reviewResponse!.allowedTools).not.toContain('Write');
    expect(reviewResponse!.allowedTools).not.toContain('Edit');
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

  it('/person includes Read, Edit, Glob, and Grep in allowed-tools', () => {
    const person = skills.find((s) => s.name === 'person');
    expect(person).toBeDefined();
    expect(person!.allowedTools).toBeDefined();
    expect(person!.allowedTools).toContain('Read');
    expect(person!.allowedTools).toContain('Edit');
    expect(person!.allowedTools).toContain('Glob');
    expect(person!.allowedTools).toContain('Grep');
    expect(person!.allowedTools).not.toContain('Bash');
    expect(person!.allowedTools).not.toContain('Write');
  });

  it('/person body references people profile path and $ARGUMENTS', () => {
    const body = registry.getBody('person')!;
    expect(body).toBeDefined();
    expect(body).toContain('$ARGUMENTS');
    expect(body).toContain('command_center/context/people');
  });

  it('all bundled skills are scoped as bundled', () => {
    for (const skill of skills) {
      expect(skill.scope).toBe('bundled');
    }
  });

  it('renderSkillPrompt correctly substitutes $ARGUMENTS in real bundled skill content', () => {
    const body = registry.getBody('simplify')!;
    expect(body).toBeDefined();
    expect(body).toContain('$ARGUMENTS');

    const rendered = renderSkillPrompt(body, 'src/lib', {
      name: 'simplify',
      scope: 'bundled',
    });

    // $ARGUMENTS replaced with the actual argument
    expect(rendered).toContain('src/lib');
    expect(rendered).not.toContain('$ARGUMENTS');
    // Envelope present
    expect(rendered).toContain('[Skill: /simplify | source: bundled]');
  });
});
