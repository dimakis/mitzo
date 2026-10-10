import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';

let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
it('binds both protected agent compiler files and rejects linked installed code', () => {
  root = mkdtempSync(join(tmpdir(), 'agent-runtime-attestation-'));
  const compiler = join(root, 'compiler');
  const recipes = join(root, 'protected');
  mkdirSync(compiler);
  mkdirSync(recipes);
  writeFileSync(join(compiler, 'index.js'), 'pinned dependency closure');
  const recipe = join(root, 'recipe.mjs');
  writeFileSync(recipe, 'pinned knowledge compiler');
  const entrypoint = join(recipes, 'compile-agent-context.mjs');
  const workspace = join(recipes, 'agent-workspace-context.mjs');
  writeFileSync(entrypoint, 'agent entrypoint A');
  writeFileSync(workspace, 'bounded workspace compiler A');
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
          '--agent-recipes-root',
          recipes,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    );
  const a = inspect();
  expect(a.agentContextCompilerSha256).toMatch(/^[a-f0-9]{64}$/);
  writeFileSync(entrypoint, 'agent entrypoint B');
  const b = inspect();
  expect(b.agentContextCompilerSha256).not.toBe(a.agentContextCompilerSha256);
  writeFileSync(workspace, 'bounded workspace compiler B');
  const c = inspect();
  expect(c.agentContextCompilerSha256).not.toBe(b.agentContextCompilerSha256);
  rmSync(entrypoint);
  symlinkSync(workspace, entrypoint);
  expect(inspect).toThrow();
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
