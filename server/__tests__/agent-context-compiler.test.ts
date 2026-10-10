import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentContextRecipe } from '@mitzo/protocol';
import { compileAgentContext, verifyCompiledAgentContext } from '../agent-context-compiler.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const recipe: AgentContextRecipe = {
  version: 1,
  source: 'workspace',
  files: ['docs/design.md'],
  tokenBudget: 1000,
  required: [['docs/design.md', 'Design', 'Architecture']],
  excluded: [['docs/design.md', 'Design', 'Legacy']],
};
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'mitzo-agent-context-'));
  roots.push(root);
  await mkdir(join(root, 'docs'));
  await writeFile(
    join(root, 'AGENTS.md'),
    '# Required rules\nKeep user files safe.\n@not-an-import.md',
  );
  await writeFile(
    join(root, 'docs/design.md'),
    '# Design\n\n## Architecture\nUse queues.\n\n## Legacy\nExcluded obsolete advice.',
  );
  return root;
}
it('uses real ContexGin compilation for selected documents and preserves canonical instructions', async () => {
  const root = await workspace();
  const result = await compileAgentContext(recipe, { workspaceRoot: root });
  expect(result.context.fullMarkdown).toContain('Use queues.');
  expect(result.context.fullMarkdown).toContain(
    '# Required rules\nKeep user files safe.\n@not-an-import.md',
  );
  expect(result.context.fullMarkdown).not.toContain('Excluded obsolete advice');
  expect(result.context.sources.map((source) => source.path)).toEqual([
    'AGENTS.md',
    'docs/design.md',
  ]);
  expect(result.context.tokenCount).toBeLessThanOrEqual(1000);
  expect(result.recipeHash).toMatch(/^[a-f0-9]{64}$/);
  expect(result.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  expect(await verifyCompiledAgentContext(result, recipe, { workspaceRoot: root })).toEqual(result);
});
it('refuses exclusions and insufficient budgets that would remove required workspace instructions', async () => {
  const root = await workspace();
  await expect(
    compileAgentContext({ ...recipe, excluded: [['AGENTS.md']] }, { workspaceRoot: root }),
  ).rejects.toThrow(/instructions/);
  await expect(
    compileAgentContext(
      { ...recipe, excluded: [['AGENTS.md', 'Required rules']] },
      { workspaceRoot: root },
    ),
  ).rejects.toThrow(/instructions/);
  await writeFile(join(root, 'AGENTS.md'), '# Rules\n' + 'Mandatory rule. '.repeat(400));
  await expect(
    compileAgentContext({ ...recipe, tokenBudget: 256 }, { workspaceRoot: root }),
  ).rejects.toThrow(/budget/);
});
it('requires selected documents and required sections instead of silently dropping unavailable context', async () => {
  const root = await workspace();
  await expect(
    compileAgentContext({ ...recipe, files: ['missing.md'] }, { workspaceRoot: root }),
  ).rejects.toThrow(/missing.md/);
  await expect(
    compileAgentContext({ ...recipe, required: [['Missing heading']] }, { workspaceRoot: root }),
  ).rejects.toThrow(/Required context/);
});
it('records optional trimming without truncating required instructions', async () => {
  const root = await workspace();
  await writeFile(
    join(root, 'docs/design.md'),
    '# Design\n## Architecture\nUse queues.\n## Background\n' + 'Extra context. '.repeat(400),
  );
  const result = await compileAgentContext(
    { ...recipe, tokenBudget: 256 },
    { workspaceRoot: root },
  );
  expect(result.context.fullMarkdown).toContain('Keep user files safe.');
  expect(result.context.trimmed.map((section) => section.heading)).toContain(
    'docs/design.md > Design > Background',
  );
});

it('excludes nested headings even in short documents without delivering their private content', async () => {
  const root = await workspace();
  await writeFile(
    join(root, 'docs/design.md'),
    '# Design\nOverview.\n## Architecture\nPublic choice.\n### Private notes\nNever deliver this source text.\n### Rationale\nUse typed interfaces.',
  );
  const result = await compileAgentContext(
    { ...recipe, excluded: [['docs/design.md', 'Design', 'Architecture', 'Private notes']] },
    { workspaceRoot: root },
  );
  expect(result.context.fullMarkdown).toContain('Use typed interfaces.');
  expect(result.context.fullMarkdown).toContain('Public choice.');
  expect(result.context.fullMarkdown).not.toContain('Never deliver this source text.');
  expect(result.context.fullMarkdown).not.toContain('Private notes');
});
it('resolves required top-level headings in documents with no level-two sections', async () => {
  const root = await workspace();
  await writeFile(join(root, 'docs/design.md'), '# Policy\nKeep state explicit.');
  const result = await compileAgentContext(
    { ...recipe, required: [['docs/design.md', 'Policy']], excluded: [] },
    { workspaceRoot: root },
  );
  expect(result.context.fullMarkdown).toContain('Keep state explicit.');
});
it('prefers AGENTS.md and preserves all of legacy CLAUDE.md when canonical instructions are absent', async () => {
  const root = await workspace();
  await writeFile(join(root, 'CLAUDE.md'), '# Legacy rules\nLegacy rule.');
  expect(
    (
      await compileAgentContext(
        { ...recipe, files: ['CLAUDE.md', 'docs/design.md'] },
        { workspaceRoot: root },
      )
    ).context.fullMarkdown,
  ).not.toContain('Legacy rule.');
  await rm(join(root, 'AGENTS.md'));
  expect(
    (await compileAgentContext(recipe, { workspaceRoot: root })).context.fullMarkdown,
  ).toContain('# Legacy rules\nLegacy rule.');
});
it('rejects linked source files and linked parent directories even inside the selected workspace', async () => {
  const root = await workspace();
  await symlink(join(root, 'docs/design.md'), join(root, 'linked.md'));
  await symlink(join(root, 'docs'), join(root, 'linked'));
  for (const file of ['linked.md', 'linked/design.md']) {
    await expect(
      compileAgentContext({ ...recipe, files: [file] }, { workspaceRoot: root }),
    ).rejects.toThrow(/symlink/);
  }
});
it('rejects oversized documents and preserves an aborted compilation', async () => {
  const root = await workspace();
  await writeFile(join(root, 'docs/design.md'), 'x'.repeat(65537));
  await expect(compileAgentContext(recipe, { workspaceRoot: root })).rejects.toThrow(/too large/);
  const controller = new AbortController();
  controller.abort();
  await expect(
    compileAgentContext(recipe, { workspaceRoot: root, signal: controller.signal }),
  ).rejects.toThrow(/abort/i);
});
it('detects changed recipes, payload tampering, and another workspace when restoring a compiled snapshot', async () => {
  const root = await workspace();
  const other = await workspace();
  const result = await compileAgentContext(recipe, { workspaceRoot: root });
  await expect(
    verifyCompiledAgentContext(result, { ...recipe, tokenBudget: 2000 }, { workspaceRoot: root }),
  ).rejects.toThrow(/recipe/);
  await expect(
    verifyCompiledAgentContext(
      { ...result, context: { ...result.context, fullMarkdown: 'Tampered' } },
      recipe,
      { workspaceRoot: root },
    ),
  ).rejects.toThrow(/hash/);
  await expect(
    verifyCompiledAgentContext(result, recipe, { workspaceRoot: other }),
  ).rejects.toThrow(/workspace/);
  await writeFile(join(root, 'docs/design.md'), 'Changed live source');
  expect(await verifyCompiledAgentContext(result, recipe, { workspaceRoot: root })).toEqual(result);
});
it('compiles a named preset only at the configured ContexGin service, without a fallback', async () => {
  const preset: AgentContextRecipe = { version: 1, source: 'contexgin', agentName: 'architect' };
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          agent: 'architect',
          boot: {
            content: '# Preset\nCompiled guidance',
            tokens: 8,
            tokenBudget: 1000,
            sources: ['memory/architecture.md'],
          },
        }),
      ),
  );
  const result = await compileAgentContext(preset, {
    contexginUrl: 'http://configured.test:9999',
    fetch: fetcher,
  });
  expect(fetcher).toHaveBeenCalledWith(
    'http://configured.test:9999/api/agents/architect/context',
    expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }),
  );
  expect(result.context.fullMarkdown).toContain('Compiled guidance');
  expect(result.context.sources[0].path).toBe('memory/architecture.md');
  await expect(
    compileAgentContext(preset, { fetch: async () => new Response('{}', { status: 404 }) }),
  ).rejects.toThrow(/ContexGin/);
});
it.each([
  { agent: 'other', boot: { content: 'Wrong agent', tokens: 2, tokenBudget: 100, sources: [] } },
  { agent: 'architect', boot: {} },
  { agent: 'architect', boot: { content: '', tokens: 0, tokenBudget: 100, sources: [] } },
  { agent: 'architect', boot: { content: '   \n', tokens: 2, tokenBudget: 100, sources: [] } },
  {
    agent: 'architect',
    boot: { content: 'Uncounted content', tokens: 0, tokenBudget: 100, sources: [] },
  },
  {
    agent: 'architect',
    boot: { content: 'Over budget', tokens: 101, tokenBudget: 100, sources: [] },
  },
])('rejects malformed, mismatched or incomplete ContexGin preset output', async (body) => {
  await expect(
    compileAgentContext(
      { version: 1, source: 'contexgin', agentName: 'architect' },
      {
        fetch: async () => new Response(JSON.stringify(body)),
      },
    ),
  ).rejects.toThrow();
});

it('stops reading and cancels oversized ContexGin output before buffering the full response', async () => {
  let chunks = 0;
  const cancelled = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      chunks++;
      controller.enqueue(new Uint8Array(600000));
      if (chunks === 5) controller.close();
    },
    cancel: cancelled,
  });
  await expect(
    compileAgentContext(
      { version: 1, source: 'contexgin', agentName: 'architect' },
      {
        fetch: async () => new Response(body),
      },
    ),
  ).rejects.toThrow(/too large/);
  expect(chunks).toBeLessThan(5);
  expect(cancelled).toHaveBeenCalledOnce();
});
