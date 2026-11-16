import './fixtures/offline-user-home.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClaudeStartupContext } from '../claude-startup-context.js';
import { installHostKnowledgeStore, readHostKnowledge } from '../published-host-knowledge.js';
import { hostKnowledgePublication } from './fixtures/host-knowledge-publication.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});
async function fixture(file = 'AGENTS.md') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'claude-startup-context-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  if (file) await writeFile(join(root, file), '# Task instructions\nKeep the selected branch.');
  const session = {};
  const controller = new AbortController();
  let current = true;
  const assertCurrent = async () => {
    if (!current) throw Error('account revoked');
  };
  const context = createClaudeStartupContext({
    session,
    cwd: root,
    preserveProfile: false,
    assertCurrent,
  });
  return {
    root,
    session,
    controller,
    context,
    revoke: () => {
      current = false;
    },
  };
}
it.each(['AGENTS.md', 'CLAUDE.md', ''])(
  'prepares admitted project instructions (%s) and accepted shared memory',
  async (file) => {
    const f = await fixture(file);
    const publication = hostKnowledgePublication(f.root, 'a', 'Accepted shared observation');
    cleanups.push(installHostKnowledgeStore({ id: 'mgmt', reconcile: async () => publication }));
    await f.context.prepare(f.controller.signal);
    expect(f.context.text()).toContain('Published MGMT knowledge');
    expect(f.context.text()).toContain('ReadKnowledge');
    expect(f.context.text().includes('Keep the selected branch.')).toBe(!!file);
    expect(f.context.receipt()).toMatchObject({ sourceCommit: publication.sourceCommit });
    expect(await readHostKnowledge(f.session, 'memory/Observations/lesson.md')).toMatchObject({
      content: 'Accepted shared observation',
    });
    f.context.assertCurrent();
  },
);
it('does not invent a publication for an unknown enrollment', async () => {
  const f = await fixture();
  await f.context.prepare(f.controller.signal);
  expect(f.context.text()).toContain('Keep the selected branch.');
  expect(f.context.text()).not.toContain('Published MGMT knowledge');
  expect(f.context.receipt()).toBeUndefined();
  expect(await readHostKnowledge(f.session)).toBeUndefined();
});
it.each(['account', 'publication', 'cancel'] as const)(
  'withholds preparation after %s changes during reconciliation',
  async (change) => {
    const f = await fixture();
    const publication = hostKnowledgePublication(f.root, 'a', 'PRIVATE_UNDELIVERED');
    const restore = installHostKnowledgeStore({
      id: 'mgmt',
      reconcile: async () => {
        if (change === 'account') f.revoke();
        if (change === 'publication') restore();
        if (change === 'cancel') f.controller.abort();
        return publication;
      },
    });
    cleanups.push(restore);
    await expect(f.context.prepare(f.controller.signal)).rejects.toThrow();
    expect(f.context.text()).toBe('');
    expect(() => f.context.assertCurrent()).toThrow();
  },
);
it('pins a publication until replacement, refuses revocation, and clears stale context on refresh failure', async () => {
  const f = await fixture();
  const first = hostKnowledgePublication(f.root, 'a', 'First accepted');
  const second = hostKnowledgePublication(f.root, 'b', 'Second accepted');
  const reconcile = vi
    .fn()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(second)
    .mockRejectedValueOnce(Error('publication unavailable'));
  const restore = installHostKnowledgeStore({ id: 'mgmt', reconcile });
  cleanups.push(restore);
  await f.context.prepare(f.controller.signal);
  expect(f.context.receipt()?.sourceCommit).toBe(first.sourceCommit);
  await f.context.prepare(f.controller.signal);
  expect(f.context.receipt()?.sourceCommit).toBe(second.sourceCommit);
  await expect(f.context.prepare(f.controller.signal)).rejects.toThrow('publication unavailable');
  expect(f.context.text()).toBe('');
  expect(await readHostKnowledge(f.session)).toBeUndefined();
  await expect(f.context.prepare(f.controller.signal)).rejects.toThrow();
  restore();
});
it('refuses a retained context after publication enrollment is revoked', async () => {
  const f = await fixture();
  const publication = hostKnowledgePublication(f.root, 'a', 'Accepted');
  const restore = installHostKnowledgeStore({ id: 'mgmt', reconcile: async () => publication });
  cleanups.push(restore);
  await f.context.prepare(f.controller.signal);
  restore();
  expect(() => f.context.assertCurrent()).toThrow(/selection|acknowledgement/);
});
it.each(['private', 'symlink'] as const)('refuses %s project instruction roots', async (kind) => {
  const f = await fixture();
  if (kind === 'private') vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', f.root);
  else {
    await rm(join(f.root, 'AGENTS.md'));
    await writeFile(join(f.root, 'secret'), 'PRIVATE_INSTRUCTION');
    await symlink(join(f.root, 'secret'), join(f.root, 'AGENTS.md'));
  }
  await expect(f.context.prepare(f.controller.signal)).rejects.toThrow(/not allowed|symlink/);
  expect(f.context.text()).toBe('');
});
