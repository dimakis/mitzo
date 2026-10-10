import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('uses shared rhythm and touch-target tokens in the home, quote and nickname patterns', () => {
  const css = readFileSync(resolve(__dirname, '../home.css'), 'utf8');
  for (const declaration of css.matchAll(
    /((?:font-size|border-radius|gap|padding(?:-[\w-]+)?|margin(?:-[\w-]+)?)):\s*([^;]+);/g,
  )) {
    expect(declaration[2], declaration[1]).not.toMatch(/\d+(?:\.\d+)?(?:px|rem)\b/);
  }
  expect(css).not.toMatch(/min-height:\s*44px\b/);
  expect(css).toContain('min-height: var(--control-height)');
  const dialog = css.match(/\.home-dialog\s*\{([^}]+)\}/)?.[1];
  expect(dialog).toContain('var(--page-gutter)');
  expect(dialog).toMatch(/margin:\s*auto;/);
});
