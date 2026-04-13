import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, it, expect } from 'vitest';

const css = readFileSync(resolve(__dirname, '../global.css'), 'utf-8');

// Extract :root block content
const rootMatch = css.match(/:root\s*\{([^}]+)\}/);
const rootBlock = rootMatch?.[1] ?? '';

describe('design tokens', () => {
  describe('required CSS variables are defined in :root', () => {
    const requiredVars = [
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
    const typeVars = ['--text-xs', '--text-sm', '--text-base', '--text-lg', '--text-xl'];

    for (const v of typeVars) {
      it(`defines ${v}`, () => {
        expect(rootBlock).toContain(`${v}:`);
      });
    }
  });

  describe('spacing scale variables', () => {
    const spaceVars = [
      '--space-1',
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
