import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { describe, it, expect } from 'vitest';

const css = readFileSync(resolve(__dirname, '../tokens.css'), 'utf-8');

// Extract :root block content
const rootMatch = css.match(/:root\s*\{([^}]+)\}/);
const rootBlock = rootMatch?.[1] ?? '';

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
      for (const definition of source.matchAll(
        /--(?:color-accent|font-ui|font-mono|workspace-accent|ui-font):\s*([^;]+);/g,
      )) {
        expect(definition[1].trim(), file.name).toMatch(/^var\(/);
      }
      expect(source, file.name).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(\s*\d/i);
      for (const font of source.matchAll(/font-family:\s*([^;]+);/g)) {
        expect(font[1].trim(), file.name).toMatch(/^(var\(|inherit$)/);
      }
    }
  });
  describe('required CSS variables are defined in :root', () => {
    const requiredVars = [
      '--ui-font',
      '--bg',
      '--surface',
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
