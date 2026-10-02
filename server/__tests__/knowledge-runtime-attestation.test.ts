import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';

let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
it('attests the actual compiler dependency closure and recipe separately', () => {
  root = mkdtempSync(join(tmpdir(), 'runtime-attestation-'));
  const compiler = join(root, 'compiler');
  mkdirSync(join(compiler, 'dist'), { recursive: true });
  mkdirSync(join(compiler, 'node_modules/yaml'), { recursive: true });
  writeFileSync(join(compiler, 'dist/index.js'), 'export const compile = () => {};');
  writeFileSync(join(compiler, 'node_modules/yaml/index.js'), 'parser A');
  const recipe = join(root, 'recipe.mjs');
  writeFileSync(recipe, 'compile({ workspaceRoot, tokenBudget: 12000 });');
  const inspect = () =>
    JSON.parse(
      execFileSync(
        'python3',
        [
          resolve('scripts/attest-knowledge-runtime.py'),
          '--compiler-root',
          compiler,
          '--recipe',
          recipe,
          '--compiler-commit',
          'a'.repeat(40),
          '--fingerprints-only',
        ],
        { encoding: 'utf8' },
      ),
    );
  const a = inspect();
  writeFileSync(join(compiler, 'node_modules/yaml/index.js'), 'parser B');
  const b = inspect();
  expect(b.knowledgeCompilerSha256).not.toBe(a.knowledgeCompilerSha256);
  expect(b.knowledgeRecipeSha256).toBe(a.knowledgeRecipeSha256);
  writeFileSync(recipe, 'compile({ workspaceRoot, tokenBudget: 8000 });');
  const c = inspect();
  expect(c.knowledgeCompilerSha256).toBe(b.knowledgeCompilerSha256);
  expect(c.knowledgeRecipeSha256).not.toBe(b.knowledgeRecipeSha256);
  expect(c.knowledgeSchemaVersion).toBe(1);
});
