import { describe, expect, it, vi } from 'vitest';
import {
  OpenShellRuntimeManager,
  openShellCodexRuntimeConfig,
  openShellRuntimeConfig,
  sandboxNameForConversation,
} from '../openshell-runtime.js';

const config = {
  image: 'mitzo-runtime:1',
  policy: '/config/policy.yaml',
  seed: '/seed/mgmt',
  serviceProviders: ['google-workspace', 'github'],
  workspace: 'mitzo',
  gateway: 'local',
  workdir: '/sandbox/workspaces/mgmt',
  webSearch: 'disabled' as const,
  accountProvider: 'openai-work',
};
const owner = '8b34dbc2c05eb4d7e25d48efeace82456b16cee760bcae80c157f52a3c2e787b';
const ready = (phase = 'Ready') =>
  JSON.stringify({
    name: 'sandbox',
    phase,
    labels: { 'mitzo.conversation': owner, 'mitzo.account_provider': 'openai-work' },
  });

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
      .mockResolvedValueOnce(ready());
    const result = await new OpenShellRuntimeManager(config, run).ensure(
      'conversation',
      new AbortController().signal,
    );
    expect(result.workdir).toBe('/sandbox/workspaces/mgmt');
    const create = run.mock.calls[1][0] as string[];
    expect(create).toContain('create');
    expect(create).toContain('/seed/mgmt:/sandbox/workspaces/mgmt');
    expect(create.filter((value) => value === '--provider')).toHaveLength(3);
    expect(create.filter((_, index) => create[index - 1] === '--provider')).toEqual([
      'openai-work',
      'google-workspace',
      'github',
    ]);
    expect(create).toContain('mitzo.account_provider=openai-work');
    expect(create).not.toContain('auto-providers');
  });

  it('waits through asynchronous creation phases until the sandbox is Ready', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('sandbox not found'))
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce(ready('Creating'))
      .mockResolvedValueOnce(ready('Starting'))
      .mockResolvedValueOnce(ready());
    await expect(
      new OpenShellRuntimeManager(config, run, {
        pollIntervalMs: 0,
        timeoutMs: 100,
      }).ensure('conversation', new AbortController().signal),
    ).resolves.toMatchObject({ workdir: '/sandbox/workspaces/mgmt' });
    expect(run).toHaveBeenCalledTimes(5);
  });

  it('bounds and aborts readiness polling', async () => {
    const creating = vi.fn().mockResolvedValue(ready('Creating'));
    await expect(
      new OpenShellRuntimeManager(config, creating, {
        pollIntervalMs: 0,
        timeoutMs: 5,
      }).ensure('conversation', new AbortController().signal),
    ).rejects.toThrow('did not become Ready');

    const controller = new AbortController();
    const pending = new OpenShellRuntimeManager(config, creating, {
      pollIntervalMs: 1_000,
      timeoutMs: 30_000,
    }).ensure('conversation', controller.signal);
    await vi.waitFor(() => expect(creating).toHaveBeenCalled());
    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
  });

  it('reuses Ready and starts Stopped sandboxes without recreating them', async () => {
    const readyRun = vi.fn().mockResolvedValue(ready());
    await new OpenShellRuntimeManager(config, readyRun).ensure(
      'conversation',
      new AbortController().signal,
    );
    expect(readyRun).toHaveBeenCalledTimes(1);

    const stopped = vi
      .fn()
      .mockResolvedValueOnce(ready('Stopped'))
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce(ready('Starting'))
      .mockResolvedValueOnce(ready());
    await new OpenShellRuntimeManager(config, stopped, {
      pollIntervalMs: 0,
      timeoutMs: 100,
    }).ensure('conversation', new AbortController().signal);
    expect(stopped.mock.calls[1][0]).toContain('start');
    expect(stopped.mock.calls.flat().flat()).not.toContain('create');
  });

  it('fails closed on errored or incomplete runtimes', async () => {
    const run = vi.fn().mockResolvedValue(ready('Error'));
    await expect(
      new OpenShellRuntimeManager(config, run).ensure('conversation', new AbortController().signal),
    ).rejects.toThrow('is Error');
  });

  it('does not adopt a same-named sandbox owned by another conversation', async () => {
    const run = vi.fn().mockResolvedValue(
      JSON.stringify({
        name: 'sandbox',
        phase: 'Ready',
        labels: {
          'mitzo.conversation': 'different',
          'mitzo.account_provider': 'openai-work',
        },
      }),
    );
    await expect(
      new OpenShellRuntimeManager(config, run).ensure('conversation', new AbortController().signal),
    ).rejects.toThrow('not owned');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a sandbox bound to another API provider', async () => {
    const run = vi.fn().mockResolvedValue(
      JSON.stringify({
        name: 'sandbox',
        phase: 'Ready',
        labels: {
          'mitzo.conversation': owner,
          'mitzo.account_provider': 'openai-other',
        },
      }),
    );
    await expect(
      new OpenShellRuntimeManager(config, run).ensure('conversation', new AbortController().signal),
    ).rejects.toThrow('another account provider');
  });

  it('compiles launch context against the exact sandbox workspace', async () => {
    const run = vi.fn().mockResolvedValue(
      JSON.stringify({
        type: 'boot_context',
        scope: 'sandbox',
        sourceCount: 1,
        tokenCount: 2,
        tokenBudget: 12000,
        sources: [{ path: 'AGENTS.md', kind: 'instructions' }],
        included: [],
        trimmed: [],
        fullMarkdown: '# Context',
      }),
    );
    const manager = new OpenShellRuntimeManager(config, run);
    await expect(
      manager.compileContext(
        { sandboxName: 'mitzo-runtime', workdir: '/sandbox/workspaces/mgmt' },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ fullMarkdown: '# Context', scope: 'sandbox' });
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
        MITZO_OPENSHELL_SERVICE_PROVIDERS: 'google-workspace,github',
      }),
    ).toMatchObject({ serviceProviders: ['google-workspace', 'github'] });
    expect(() =>
      openShellRuntimeConfig({
        MITZO_OPENSHELL_ENABLED: '1',
        MITZO_OPENSHELL_IMAGE: 'runtime:1',
        MITZO_OPENSHELL_POLICY: 'relative',
        MITZO_OPENSHELL_SEED: '/seed',
      }),
    ).toThrow('absolute');
    expect(() =>
      openShellRuntimeConfig({
        MITZO_OPENSHELL_ENABLED: '1',
        MITZO_OPENSHELL_IMAGE: 'runtime:1',
        MITZO_OPENSHELL_POLICY: '/policy',
        MITZO_OPENSHELL_SEED: '/seed',
        MITZO_OPENSHELL_WEB_SEARCH: 'enabled',
      }),
    ).toThrow('web search');
    expect(() =>
      openShellRuntimeConfig({
        MITZO_OPENSHELL_ENABLED: '1',
        MITZO_OPENSHELL_IMAGE: 'runtime:1',
        MITZO_OPENSHELL_POLICY: '/policy',
        MITZO_OPENSHELL_SEED: '/seed',
        MITZO_OPENSHELL_SERVICE_PROVIDERS: 'openai-other-account',
      }),
    ).toThrow('allowed service provider');
    expect(() =>
      openShellRuntimeConfig({
        MITZO_OPENSHELL_ENABLED: '1',
        MITZO_OPENSHELL_IMAGE: 'runtime:1',
        MITZO_OPENSHELL_POLICY: '/policy',
        MITZO_OPENSHELL_SEED: '/seed',
        MITZO_OPENSHELL_PROVIDERS: 'openai-other-account',
      }),
    ).toThrow('ambiguous');
  });

  it('passes only explicitly sandboxed MCP servers and live search to Codex', () => {
    expect(
      openShellCodexRuntimeConfig(
        { webSearch: 'live' },
        {
          docs: { execution: 'sandbox', command: '/usr/bin/docs-mcp', args: ['--stdio'] },
          host: { command: '/host/private-mcp' },
        },
      ),
    ).toEqual({
      web_search: 'live',
      'mcp_servers.docs.command': '/usr/bin/docs-mcp',
      'mcp_servers.docs.args': ['--stdio'],
      'mcp_servers.docs.enabled': true,
    });
  });

  it('rejects sandbox MCP host paths, ambiguous names, and injected environments', () => {
    expect(() =>
      openShellCodexRuntimeConfig(config, {
        docs: { execution: 'sandbox', command: 'relative-mcp' },
      }),
    ).toThrow('absolute');
    expect(() =>
      openShellCodexRuntimeConfig(config, {
        'docs.private': { execution: 'sandbox', command: '/usr/bin/docs-mcp' },
      }),
    ).toThrow('name');
    expect(() =>
      openShellCodexRuntimeConfig(config, {
        docs: { execution: 'sandbox', command: '/usr/bin/docs-mcp', env: { TOKEN: 'secret' } },
      }),
    ).toThrow('providers');
  });
});
