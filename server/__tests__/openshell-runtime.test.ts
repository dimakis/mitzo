import { describe, expect, it, vi } from 'vitest';
import {
  OpenShellRuntimeManager,
  openShellRuntimeConfig,
  sandboxNameForConversation,
} from '../openshell-runtime.js';

const config = {
  image: 'mitzo-runtime:1',
  policy: '/config/policy.yaml',
  seed: '/seed/mgmt',
  providers: ['personal-chatgpt', 'google-workspace', 'github'],
  workspace: 'mitzo',
  gateway: 'local',
  workdir: '/sandbox/workspaces/mgmt',
};

describe('OpenShell runtime lifecycle', () => {
  it('derives a stable non-revealing sandbox identity', () => {
    expect(sandboxNameForConversation('private-conversation-name')).toMatch(/^mitzo-[a-f0-9]{24}$/);
    expect(sandboxNameForConversation('private-conversation-name')).not.toContain('private');
  });

  it('creates a missing sandbox with the seed and broker providers', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('sandbox not found'))
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce(JSON.stringify({ name: 'ignored', phase: 'Ready' }));
    const result = await new OpenShellRuntimeManager(config, run).ensure(
      'conversation',
      new AbortController().signal,
    );
    expect(result.workdir).toBe('/sandbox/workspaces/mgmt');
    const create = run.mock.calls[1][0] as string[];
    expect(create).toContain('create');
    expect(create).toContain('/seed/mgmt:/sandbox/workspaces/mgmt');
    expect(create.filter((value) => value === '--provider')).toHaveLength(3);
    expect(create).not.toContain('auto-providers');
  });

  it('reuses Ready and starts Stopped sandboxes without recreating them', async () => {
    const ready = vi.fn().mockResolvedValue(JSON.stringify({ name: 'sandbox', phase: 'Ready' }));
    await new OpenShellRuntimeManager(config, ready).ensure(
      'conversation',
      new AbortController().signal,
    );
    expect(ready).toHaveBeenCalledTimes(1);

    const stopped = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ name: 'sandbox', phase: 'Stopped' }))
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce(JSON.stringify({ name: 'sandbox', phase: 'Ready' }));
    await new OpenShellRuntimeManager(config, stopped).ensure(
      'conversation',
      new AbortController().signal,
    );
    expect(stopped.mock.calls[1][0]).toContain('start');
    expect(stopped.mock.calls.flat().flat()).not.toContain('create');
  });

  it('fails closed on errored or incomplete runtimes', async () => {
    const run = vi.fn().mockResolvedValue(JSON.stringify({ name: 'sandbox', phase: 'Error' }));
    await expect(
      new OpenShellRuntimeManager(config, run).ensure('conversation', new AbortController().signal),
    ).rejects.toThrow('is Error');
  });

  it('compiles launch context against the exact sandbox workspace', async () => {
    const run = vi
      .fn()
      .mockResolvedValue(
        JSON.stringify({ type: 'boot_context', scope: 'sandbox', fullMarkdown: '# Context' }),
      );
    const manager = new OpenShellRuntimeManager(config, run);
    await expect(
      manager.compileContext(
        { sandboxName: 'mitzo-runtime', workdir: '/sandbox/workspaces/mgmt' },
        new AbortController().signal,
      ),
    ).resolves.toBe('# Context');
    expect(run.mock.calls[0][0]).toEqual(
      expect.arrayContaining([
        'exec',
        'mitzo-runtime',
        '/sandbox/compile-mgmt-context.mjs',
        '/sandbox/workspaces/mgmt',
      ]),
    );
  });

  it('accepts only explicit absolute lifecycle configuration', () => {
    expect(
      openShellRuntimeConfig({
        MITZO_OPENSHELL_ENABLED: '1',
        MITZO_OPENSHELL_IMAGE: 'runtime:1',
        MITZO_OPENSHELL_POLICY: '/policy',
        MITZO_OPENSHELL_SEED: '/seed',
        MITZO_OPENSHELL_PROVIDERS: 'openai,gws',
      }),
    ).toMatchObject({ providers: ['openai', 'gws'] });
    expect(() =>
      openShellRuntimeConfig({
        MITZO_OPENSHELL_ENABLED: '1',
        MITZO_OPENSHELL_IMAGE: 'runtime:1',
        MITZO_OPENSHELL_POLICY: 'relative',
        MITZO_OPENSHELL_SEED: '/seed',
      }),
    ).toThrow('absolute');
  });
});
