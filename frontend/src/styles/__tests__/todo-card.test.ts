import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../global.css'), 'utf8');
const workspaceCss = readFileSync(resolve(__dirname, '../workspace-work.css'), 'utf8');

function backgroundOf(styles: string, selector: string) {
  const start = styles.indexOf(`${selector} {`);
  expect(start).toBeGreaterThan(-1);
  return styles.slice(start, styles.indexOf('}', start)).match(/background:\s*([^;]+);/)?.[1];
}

describe('todo swipe hint occlusion', () => {
  // The Seen/Done layer sits behind the card. Both resting and interactive
  // backgrounds must be opaque so those labels cannot clash with card text.
  for (const selector of ['.todo-card', '.todo-card:hover,\n.todo-card:focus-within']) {
    it(`covers swipe hints in ${selector}`, () => {
      const start = css.indexOf(`${selector} {`);
      expect(start).toBeGreaterThan(-1);
      const rule = css.slice(start, css.indexOf('}', start));
      const background = rule.match(/background:\s*([^;]+);/)?.[1];
      expect(background).toBeDefined();
      expect(background).not.toMatch(/transparent|rgba\(|\/\s*[\d.]+/);
      expect(background).toContain('var(--bg)');
    });
  }

  it('matches the desktop Work page background in either theme', () => {
    const pageBackground = backgroundOf(
      workspaceCss,
      '.workspace-work .todo-page,\n.workspace-work .todo-detail-page',
    );
    expect(pageBackground).toBe('var(--workspace-bg)');
    expect(backgroundOf(workspaceCss, '.workspace-work .todo-card')).toBe(pageBackground);
  });

  it('keeps desktop hover and focus highlights opaque and within the Work palette', () => {
    const background = backgroundOf(
      workspaceCss,
      '.workspace-work .todo-card:where(:hover, :focus-within)',
    );
    expect(background).toBeDefined();
    expect(background).not.toMatch(/transparent|rgba\(|\/\s*[\d.]+|var\(--bg\)|var\(--surface\)/);
    expect(background).toContain('var(--workspace-bg)');
    expect(background).toContain('var(--workspace-panel)');
  });
});
