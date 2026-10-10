import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as contexgin from 'contexgin';
import { compileWorkspaceContext } from '../../scripts/agent-workspace-context.mjs';
import type { AgentContextRecipe } from '@mitzo/protocol';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const recipe: Extract<AgentContextRecipe, { source: 'workspace' }> = {
  version: 1,
  source: 'workspace',
  files: ['docs/design.md'],
  tokenBudget: 1000,
  required: [['docs/design.md', 'Design', 'Architecture']],
  excluded: [['docs/design.md', 'Design', 'Legacy']],
};
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'agent-shared-compiler-'));
  roots.push(root);
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'AGENTS.md'), '# Rules\nPreserve task files.');
  await writeFile(
    join(root, 'docs/design.md'),
    '# Design\n## Architecture\nUse immutable bundles.\n## Legacy\nObsolete advice.',
  );
  return root;
}
it('compiles selected sources and required governance with the same portable receipt in host and sandbox', async () => {
  const result = await compileWorkspaceContext(
    recipe,
    { workspaceRoot: await workspace() },
    contexgin,
  );
  expect(result.workspaceIdentity).toMatch(/^[a-f0-9]{64}$/);
  expect(result.context.fullMarkdown).toContain('Preserve task files.');
  expect(result.context.fullMarkdown).toContain('Use immutable bundles.');
  expect(result.context.fullMarkdown).not.toContain('Obsolete advice.');
  expect(result.context.tokenCount).toBeLessThanOrEqual(recipe.tokenBudget);
  expect(result.context.sources.map((source) => source.path)).toContain('docs/design.md');
});
it.each([
  'missing canonical',
  'symlink',
  'fifo',
  'oversized',
  'invalid utf8',
  'budget',
  'missing heading',
  'exclude canonical',
])('refuses unsafe or unsatisfiable sandbox-equivalent input: %s', async (failure) => {
  const root = await workspace();
  const chosen = structuredClone(recipe);
  let error = /canonical.*instructions/i;
  if (failure === 'missing canonical') await rm(join(root, 'AGENTS.md'));
  if (failure === 'symlink') {
    await rm(join(root, 'docs/design.md'));
    await symlink(join(root, 'AGENTS.md'), join(root, 'docs/design.md'));
    error = /symlink/;
  }
  if (failure === 'fifo') {
    await rm(join(root, 'docs/design.md'));
    execFileSync('mkfifo', [join(root, 'docs/design.md')]);
    error = /regular file/;
  }
  if (failure === 'oversized') {
    await writeFile(join(root, 'docs/design.md'), 'x'.repeat(65537));
    error = /too large/;
  }
  if (failure === 'invalid utf8') {
    await writeFile(join(root, 'docs/design.md'), Buffer.from([255]));
    error = /encoded data|encoding/;
  }
  if (failure === 'budget') {
    await writeFile(join(root, 'AGENTS.md'), 'rules '.repeat(3000));
    error = /budget/i;
  }
  if (failure === 'missing heading') {
    chosen.required = [['docs/design.md', 'Missing']];
    error = /required/i;
  }
  if (failure === 'exclude canonical') {
    chosen.excluded = [['AGENTS.md']];
    error = /exclude.*instructions/;
  }
  await expect(compileWorkspaceContext(chosen, { workspaceRoot: root }, contexgin)).rejects.toThrow(
    error,
  );
});
