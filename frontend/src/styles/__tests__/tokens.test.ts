import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { describe, it, expect } from 'vitest';

const css = readFileSync(resolve(__dirname, '../tokens.css'), 'utf-8');

// Extract :root block content
const rootMatch = css.match(/:root\s*\{([^}]+)\}/);
const rootBlock = rootMatch?.[1] ?? '';

// Exercise the same scanner with hostile snippets and the complete production tree.
const ownedTokens = new Set([...css.matchAll(/(--[\w-]+):/g)].map((match) => match[1]));

function styleViolations(source: string, filename = 'component.css'): string[] {
  const violations: string[] = [];
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const definition of clean.matchAll(/(?:^|[;{])\s*(--[\w-]+):\s*([^;}]+)(?=[;}]|$)/g)) {
    if (
      filename.endsWith('.css') &&
      ownedTokens.has(definition[1]) &&
      !/^(var|color-mix)\(/.test(definition[2].trim())
    )
      violations.push(`token override: ${definition[1]}`);
  }
  for (const definition of clean.matchAll(/(['"])(--[\w-]+)\1\s*:\s*(['"`])([^'"`]+)\3/g)) {
    if (ownedTokens.has(definition[2]) && !/^(var|color-mix)\(/.test(definition[4].trim()))
      violations.push(`inline token override: ${definition[2]}`);
  }
  if (/#[\da-f]{3,8}\b|(?:rgb|hsl)a?\(\s*\d/i.test(clean)) violations.push('palette literal');
  if (/(?:color|background(?:-color)?|fill|stroke):\s*['"]?(?:white|black)\b/i.test(clean))
    violations.push('named color');
  const fontPattern = filename.endsWith('.css')
    ? /\b(?:font-family|font):\s*([^;}]+)(?=[;}]|$)/g
    : /\bfont-family:\s*([^;}]+)(?=[;}]|$)/g;
  for (const font of clean.matchAll(fontPattern)) {
    if (!/^(var\(|inherit$)/.test(font[1].trim())) violations.push('font stack');
  }
  for (const font of clean.matchAll(/\bfontFamily\s*:\s*(['"`])([^'"`]+)\1/g)) {
    if (!/^(var\(|inherit$)/.test(font[2].trim())) violations.push('inline font stack');
  }
  return violations;
}

describe('design tokens', () => {
  it('keeps the theme and font definitions in one file', () => {
    const root = resolve(__dirname, '../../');
    const files = readdirSync(root, { recursive: true, withFileTypes: true });
    for (const file of files) {
      if (
        !file.isFile() ||
        !/\.(css|tsx?)$/.test(file.name) ||
        file.name === 'tokens.css' ||
        file.parentPath.includes('__tests__') ||
        file.parentPath.endsWith('/preview')
      )
        continue;
      const source = readFileSync(resolve(file.parentPath, file.name), 'utf8');
      expect(styleViolations(source, file.name), file.name).toEqual([]);
    }
  });
  describe('the source guard catches alternate ways to bypass shared tokens', () => {
    it.each([
      ['inline font', "const style = { fontFamily: 'Arial, sans-serif' };"],
      ['CSS font shorthand', '.new-page { font: 16px Arial; }'],
      ['HSL color', '.new-page { color: hsl(270 90% 70%); }'],
      ['spacing override', '.new-page { --space-4: 17px; }'],
      ['last declaration without semicolon', '.new-page { --space-4: 17px }'],
      ['inline token override', "const style = { '--space-4': '17px' };"],
      ['radius override', '.new-page { --radius-panel: 23px; }'],
      ['type override', '.new-page { --text-base: 19px; }'],
      ['page gutter override', '.new-page { --page-gutter: 27px; }'],
      ['mobile navigation override', '.new-page { --mobile-tabs-height: 91px; }'],
    ])('rejects %s', (_name, source) => {
      expect(styleViolations(source).length).toBeGreaterThan(0);
    });

    it('rejects CSS font-family literals embedded in TSX', () => {
      expect(
        styleViolations('const styles = `.page { font-family: Arial; }`;', 'page.tsx'),
      ).toContain('font stack');
    });

    it('does not confuse adapter token lookup expressions with CSS declarations', () => {
      expect(
        styleViolations(
          'const match = css.match(/--seat-color-default:\\s*([^;]+);/);',
          'adapter.ts',
        ),
      ).toEqual([]);
    });

    it('does not confuse selector modifiers with token declarations', () => {
      expect(styleViolations(".status--active::before { content: ''; }")).toEqual([]);
    });

    it('allows semantic aliases, inherited fonts and token-based inline fonts', () => {
      expect(
        styleViolations(`
        .new-page {
          --text-primary: var(--workspace-text);
          padding: var(--space-4);
          font-family: inherit;
          font: inherit;
          color: color-mix(in srgb, var(--color-accent) 20%, transparent);
        }
        const style = { fontFamily: 'var(--font-ui)' };
      `),
      ).toEqual([]);
    });
  });

  describe('required CSS variables are defined in :root', () => {
    const requiredVars = [
      '--ui-font',
      '--bg',
      '--surface',
      '--color-preview-canvas',
      '--border',
      '--text',
      '--text-dim',
      '--text-secondary',
      '--accent',
      '--accent-hover',
      '--danger',
      '--success',
      '--warning',
      '--bg-secondary',
      '--hover',
      '--active',
    ];

    for (const v of requiredVars) {
      it(`defines ${v}`, () => {
        expect(rootBlock).toContain(`${v}:`);
      });
    }
  });

  describe('type scale variables', () => {
    const typeVars = [
      '--text-2xs',
      '--text-xxs',
      '--text-xs',
      '--text-s',
      '--text-sm',
      '--text-md',
      '--text-base',
      '--text-lg',
      '--text-xl',
    ];

    for (const v of typeVars) {
      it(`defines ${v}`, () => {
        expect(rootBlock).toContain(`${v}:`);
      });
    }
  });

  describe('spacing scale variables', () => {
    const spaceVars = [
      '--space-1',
      '--space-1h',
      '--space-2',
      '--space-3',
      '--space-4',
      '--space-5',
      '--space-6',
    ];

    for (const v of spaceVars) {
      it(`defines ${v}`, () => {
        expect(rootBlock).toContain(`${v}:`);
      });
    }
  });

  describe('no hardcoded colors for themed values', () => {
    // These specific hex values should use CSS vars instead
    const bannedColors = [
      { hex: '#e53935', replacement: 'var(--danger)' },
      { hex: '#ff9800', replacement: 'var(--warning)' },
    ];

    for (const { hex, replacement } of bannedColors) {
      it(`does not use hardcoded ${hex} (use ${replacement})`, () => {
        // Strip the :root block — definitions there are fine
        const withoutRoot = css.replace(/:root\s*\{[^}]+\}/, '');
        expect(withoutRoot).not.toContain(hex);
      });
    }
  });
});
