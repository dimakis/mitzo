import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPermissionHandler } from '../src/permission-handler.js';
import { SessionRegistry } from '../src/session-registry.js';
import { checkWorktreePolicy } from '../src/worktree-guard.js';
import { shouldAutoAllow } from '../src/tool-tiers.js';

const registry = new SessionRegistry();
afterEach(() => registry.dispose());

describe('native SDK file-write scope', () => {
  it.each<[string, Record<string, unknown>]>([
    ['Write', { file_path: '../outside/file.ts' }],
    ['Edit', { file_path: '/task/../outside/file.ts' }],
    ['NotebookEdit', { notebook_path: '/outside/notebook.ipynb' }],
    ['NotebookEdit', { notebook_path: '../outside/notebook.ipynb' }],
  ])('refuses %s outside the current SDK cwd/worktree', async (name, input) => {
    registry.register('client', {
      sessionId: 'sdk-scope',
      cwd: '/task',
      mode: 'auto',
      abortController: new AbortController(),
      sessionAllowList: new Set(),
      transport: { isOpen: () => true, send: vi.fn() },
    });
    registry.get('client')!.worktreePaths.set('repo', { path: '/task', wtId: 'task' });
    expect(await checkWorktreePolicy(registry.get('client')!, name, input)).toContain(
      'outside session worktrees',
    );
  });

  it('uses the native NotebookEdit name in the shared Ask/Agent/Auto policy', async () => {
    expect(shouldAutoAllow('NotebookEdit', 'ask')).toBe(false);
    expect(shouldAutoAllow('NotebookEdit', 'agent')).toBe(true);
    expect(shouldAutoAllow('NotebookEdit', 'auto')).toBe(true);
    registry.register('client', {
      sessionId: 'sdk-scope',
      cwd: '/task',
      mode: 'agent',
      abortController: new AbortController(),
      sessionAllowList: new Set(),
      transport: { isOpen: () => true, send: vi.fn() },
    });
    registry.get('client')!.worktreePaths.set('repo', { path: '/task', wtId: 'task' });
    expect(
      await buildPermissionHandler('client', registry)(
        'NotebookEdit',
        { notebook_path: 'in-task.ipynb' },
        {
          signal: new AbortController().signal,
          toolUseID: 'notebook',
        },
      ),
    ).toMatchObject({ behavior: 'allow' });
  });
});
