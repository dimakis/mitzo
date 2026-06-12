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

  it('discovers all bundled skills', () => {
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual([
      'land-pr',
      'person',
      'plugin',
      'pr-review',
      'pr-shepherd',
      'review-response',
      'risk-scan',
      'simplify',
    ]);
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

  it('non-mutating bundled skills do not include Write or Edit in allowed-tools', () => {
    const nonMutating = skills.filter((s) => !s.mutating);
    expect(nonMutating.length).toBeGreaterThan(0);
    for (const skill of nonMutating) {
      if (skill.allowedTools) {
        expect(skill.allowedTools).not.toContain('Write');
        expect(skill.allowedTools).not.toContain('Edit');
      }
    }
  });

  it('mutating skills declare the flag in frontmatter and have write access', () => {
    const mutating = skills.filter((s) => s.mutating);
    expect(mutating.length).toBeGreaterThan(0);
    for (const skill of mutating) {
      const hasWriteAccess =
        skill.allowedTools?.includes('Edit') || skill.allowedTools?.includes('Write');
      expect(
        hasWriteAccess,
        `Mutating skill "${skill.name}" should have Edit or Write in allowed-tools`,
      ).toBe(true);
    }
  });

  it('non-mutating bundled skills contain an approval gate instruction', () => {
    // Non-mutating skills must include BOTH "present" AND "before making changes"
    // so users always see findings before any modifications happen.
    const nonMutating = skills.filter((s) => !s.mutating);
    for (const skill of nonMutating) {
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

  it('/land-pr includes Bash for gh CLI and git access', () => {
    const landPr = skills.find((s) => s.name === 'land-pr');
    expect(landPr).toBeDefined();
    expect(landPr!.allowedTools).toBeDefined();
    expect(landPr!.allowedTools).toContain('Bash');
    expect(landPr!.allowedTools).toContain('Read');
    expect(landPr!.allowedTools).toContain('Grep');
    expect(landPr!.allowedTools).toContain('Edit');
  });

  it('/land-pr is a mutating skill', () => {
    const landPr = skills.find((s) => s.name === 'land-pr');
    expect(landPr).toBeDefined();
    expect(landPr!.mutating).toBe(true);
  });

  it('/land-pr body references the PR lifecycle phases', () => {
    const body = registry.getBody('land-pr')!;
    expect(body).toBeDefined();
    expect(body).toContain('$ARGUMENTS');
    expect(body.toLowerCase()).toContain('ci');
    expect(body.toLowerCase()).toContain('review');
    expect(body.toLowerCase()).toContain('merge');
  });

  it('all bundled skills are scoped as bundled', () => {
    for (const skill of skills) {
      expect(skill.scope).toBe('bundled');
    }
  });

  it('/pr-shepherd is a mutating skill with full tool access', () => {
    const prShepherd = skills.find((s) => s.name === 'pr-shepherd');
    expect(prShepherd).toBeDefined();
    expect(prShepherd!.mutating).toBe(true);
    expect(prShepherd!.allowedTools).toBeDefined();
    expect(prShepherd!.allowedTools).toContain('Bash');
    expect(prShepherd!.allowedTools).toContain('Read');
    expect(prShepherd!.allowedTools).toContain('Edit');
    expect(prShepherd!.allowedTools).toContain('Write');
    expect(prShepherd!.allowedTools).toContain('Agent');
  });

  it('/pr-shepherd body references the shepherd loop and merge gate', () => {
    const body = registry.getBody('pr-shepherd')!;
    expect(body).toBeDefined();
    expect(body).toContain('$ARGUMENTS');
    expect(body.toLowerCase()).toContain('conflict');
    expect(body.toLowerCase()).toContain('ci');
    expect(body.toLowerCase()).toContain('review');
    expect(body.toLowerCase()).toContain('merge-ready');
    expect(body.toLowerCase()).toContain('schedulewakeup');
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

  it('/plugin is a mutating skill with Bash and Write access', () => {
    const plugin = skills.find((s) => s.name === 'plugin');
    expect(plugin).toBeDefined();
    expect(plugin!.mutating).toBe(true);
    expect(plugin!.allowedTools).toBeDefined();
    expect(plugin!.allowedTools).toContain('Bash');
    expect(plugin!.allowedTools).toContain('Write');
    expect(plugin!.allowedTools).toContain('Read');
    expect(plugin!.allowedTools).toContain('Glob');
    expect(plugin!.allowedTools).toContain('AskUserQuestion');
  });

  it('/plugin body references marketplace config paths and $ARGUMENTS', () => {
    const body = registry.getBody('plugin')!;
    expect(body).toBeDefined();
    expect(body).toContain('$ARGUMENTS');
    expect(body).toContain('~/.mitzo/plugins/config.json');
    expect(body).toContain('~/.mitzo/plugins/installed.json');
    expect(body).toContain('registry.yaml');
  });
});
