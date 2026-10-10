import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

function violations(source: string, filename: string): string[] {
  const issues: string[] = [];
  const timing = (raw: string) => {
    const value = raw.replace(/var\(\s*--[\w-]+\s*\)/g, '');
    if (/(?:^|[\s,])(?:\d*\.)?\d+m?s\b/.test(value)) issues.push('literal duration');
    if (/cubic-bezier\(|\bease(?:-in)?(?:-out)?\b/.test(value)) issues.push('literal easing');
    if (/\ball\b/.test(value)) issues.push('transition all');
  };
  if (filename.endsWith('.css')) {
    const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of clean.matchAll(/\b(?:transition|animation)(?:-[\w-]+)?\s*:\s*([^;}]+)/g))
      timing(match[1]);
  } else {
    const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'animate'
      )
        issues.push('use shared animateMotion');
      if (
        ts.isBinaryExpression(node) &&
        ts.isPropertyAccessExpression(node.left) &&
        /^(transition|animation)/.test(node.left.name.text) &&
        ts.isStringLiteralLike(node.right)
      )
        timing(node.right.text);
      if (
        ts.isPropertyAssignment(node) &&
        /^(transition|animation)/.test(node.name.getText(file).replace(/['"]/g, '')) &&
        ts.isStringLiteralLike(node.initializer)
      )
        timing(node.initializer.text);
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return issues;
}

describe('motion contract', () => {
  it('requires every production interaction to use shared motion tokens and helpers', () => {
    const root = resolve(__dirname, '../..');
    const issues: string[] = [];
    for (const file of readdirSync(root, { recursive: true, withFileTypes: true })) {
      const path = resolve(file.parentPath, file.name);
      if (
        !file.isFile() ||
        !/\.(css|tsx?)$/.test(path) ||
        path.includes('/__tests__/') ||
        path.includes('/preview/') ||
        path.endsWith('/tokens.css') ||
        path.endsWith('/lib/motion.ts')
      )
        continue;
      issues.push(
        ...violations(readFileSync(path, 'utf8'), file.name).map(
          (issue) => `${path.slice(root.length + 1)}: ${issue}`,
        ),
      );
    }
    expect(issues).toEqual([]);
  });
  it.each([
    ['.card { transition: opacity 250ms; }', 'card.css'],
    ['.card { animation-duration: .2s; }', 'card.css'],
    ['.card { transition: opacity var(--motion-duration-fast) ease-in-out; }', 'card.css'],
    ["element.style.transition = 'opacity 0.2s';", 'card.tsx'],
    ["const style = { transitionDuration: '250ms' };", 'card.tsx'],
    ['element.animate([], { duration: 250 });', 'card.tsx'],
    ['.card { transition: all var(--motion-duration-fast); }', 'card.css'],
  ])('rejects motion outside the shared contract: %s', (source, file) => {
    expect(violations(source, file).length).toBeGreaterThan(0);
  });
  it('allows token-based transitions and sustained status motion', () => {
    expect(
      violations(
        '.card { transition: opacity var(--motion-duration-fast) var(--motion-ease); animation: spin var(--motion-duration-spin) linear infinite; }',
        'card.css',
      ),
    ).toEqual([]);
  });
});
