import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../global.css'), 'utf8');

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
});
