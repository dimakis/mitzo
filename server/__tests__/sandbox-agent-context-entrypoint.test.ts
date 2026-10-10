import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';

const entrypoint = resolve('docs/spikes/openshell-codex/compile-agent-context.mjs');
const recipe = {
  version: 1,
  source: 'workspace',
  files: ['design.md'],
  tokenBudget: 1000,
  required: [],
  excluded: [],
};
function fixture(
  run: (root: string, invoke: (input: unknown) => ReturnType<typeof spawnSync>) => void,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-recipe-entrypoint-')));
  try {
    const workspace = join(root, 'workspaces', 'task');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'AGENTS.md'), '# Rules\nPreserve task roots.');
    writeFileSync(join(workspace, 'design.md'), '# Architecture\nUse sandbox-selected context.');
    // Model the installed protected files and sandbox mount without modifying this Mac's /sandbox.
    const source = readFileSync(entrypoint, 'utf8')
      .replace('/usr/lib/contexgin/dist/index.js', resolve('node_modules/contexgin/dist/index.js'))
      .replace(
        '/usr/libexec/mitzo/agent-workspace-context.mjs',
        resolve('scripts/agent-workspace-context.mjs'),
      )
      .replaceAll('/sandbox/workspaces/', join(root, 'workspaces') + '/');
    const path = join(root, 'compiler.mjs');
    writeFileSync(path, source);
    run(workspace, (input) =>
      spawnSync(process.execPath, [path, Buffer.from(JSON.stringify(input)).toString('base64')], {
        encoding: 'utf8',
        timeout: 3000,
        maxBuffer: 2 * 1024 * 1024,
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
it('runs the protected entrypoint with bounded preloaded sources and a sandbox scope receipt', () => {
  fixture((root, invoke) => {
    const result = invoke({ workspaceRoot: root, recipe });
    expect(result.status, String(result.stderr)).toBe(0);
    const response = JSON.parse(String(result.stdout));
    expect(response.compilerRevision).toMatch(/^mitzo-sandbox-context-v1:/);
    expect(response.workspaceIdentity).toMatch(/^[a-f0-9]{64}$/);
    expect(response.context.fullMarkdown).toContain('Preserve task roots.');
    expect(response.context.fullMarkdown).toContain('Use sandbox-selected context.');
  });
});
it('rejects a task root switched to an outside link after the initial physical-root check', () => {
  fixture((root, invoke) => {
    const outside = resolve(root, '../..', 'outside-task');
    mkdirSync(outside);
    writeFileSync(join(outside, 'AGENTS.md'), '# Outside instructions\nOUTSIDE TASK AUTHORITY');
    writeFileSync(join(outside, 'design.md'), '# Outside data\nDo not read this selection.');
    const path = resolve(root, '../..', 'compiler.mjs');
    const source = readFileSync(path, 'utf8').replace(
      'const compiled = await compileWorkspaceContext',
      `const fs = await import('node:fs/promises');
       await fs.rename(workspaceRoot, workspaceRoot + '.before');
       await fs.symlink(${JSON.stringify(outside)}, workspaceRoot);
       const compiled = await compileWorkspaceContext`,
    );
    writeFileSync(path, source);
    const result = invoke({ workspaceRoot: root, recipe });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/physical|root changed/);
  });
});
it.each([
  'host root',
  'traversal',
  'URL',
  'unknown fields',
  'invalid budget',
  'preset fetch',
  'fifo',
])('rejects unauthorized input before returning compiled context: %s', (failure) => {
  fixture((root, invoke) => {
    const input = { workspaceRoot: root, recipe: structuredClone(recipe) };
    if (failure === 'host root') input.workspaceRoot = '/Users/operator/work';
    if (failure === 'traversal') input.recipe.files = ['../secret.md'];
    if (failure === 'URL') input.recipe.files = ['https://example.com/secret.md'];
    if (failure === 'unknown fields') Object.assign(input.recipe, { grants: ['github'] });
    if (failure === 'invalid budget') input.recipe.tokenBudget = 32001;
    if (failure === 'preset fetch')
      Object.assign(input.recipe, { source: 'contexgin', agentName: 'architect' });
    if (failure === 'fifo') {
      rmSync(join(root, 'design.md'));
      execFileSync('mkfifo', [join(root, 'design.md')]);
    }
    const result = invoke(input);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.error).toBeUndefined();
  });
});
