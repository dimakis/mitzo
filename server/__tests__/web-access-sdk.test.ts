import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWebAccessSdkServer, webAccessSdkPermission } from '../web-access-sdk.js';
import { createSdkCallbackState } from '../ordinary-local-vertex-sdk-query.js';
import { executeWebAccess, WebAccessError } from '../request-web-access.js';
import { retainCallbackOutcome } from '../turn-callbacks.js';
describe('Claude SDK web access surface', () => {
  it.each(['completed failure', 'unknown failure', 'cancelled'] as const)(
    'retains the original outcome of a %s through MCP and turn settlement',
    async (outcome) => {
      const state = createSdkCallbackState();
      const abort = new AbortController();
      const server = createWebAccessSdkServer(
        (input, signal) =>
          executeWebAccess(input, signal, {
            isCurrent: () => true,
            approve: async (request) => ({ behavior: 'allow', updatedInput: request }),
            search: async () => {
              if (outcome === 'cancelled') abort.abort(Error('cancelled'));
              const error = new WebAccessError('Search failed on the selected route');
              if (outcome === 'unknown failure') retainCallbackOutcome(error, 'unknown');
              throw error;
            },
            fetchPage: async () => 'unused',
          }),
        abort.signal,
        undefined,
        state.runCallback,
      );
      const client = new Client({ name: 'failed-search', version: '1' });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.instance.connect(a);
      await client.connect(b);
      try {
        expect(
          (
            await client.callTool({
              name: 'RequestWebAccess',
              arguments: { operation: 'search', query: 'offline fixture', reason: 'regression' },
            })
          ).isError,
        ).toBe(true);
        // Unknown and cancelled outcomes stay retained as uncertain for the
        // terminal notice; only a completed failure is settled evidence.
        await expect(state.callbacks.settle(new AbortController().signal)).resolves.toBeUndefined();
        expect(state.callbacks.uncertainOutcomes).toBe(outcome === 'completed failure' ? 0 : 1);
      } finally {
        await client.close();
        await server.instance.close();
      }
    },
  );
  it.each(
    [[], ['RequestWebAccess'], ['mcp__mitzo-web-access__RequestWebAccess']].map((ceiling) => ({
      ceiling,
    })),
  )(
    'checks the immutable original wire name before a web effect ($ceiling)',
    async ({ ceiling }) => {
      const state = createSdkCallbackState();
      state.bindCommandToolAuthority({
        commandId: 'original',
        checkTool: (name) => (ceiling.includes(name) ? 'allow' : 'deny'),
      });
      const execute = vi.fn().mockResolvedValue({ content: 'answer', isError: false });
      const server = createWebAccessSdkServer(
        execute,
        new AbortController().signal,
        undefined,
        state.runCallback,
        (name) => state.checkTool(name),
      );
      const client = new Client({ name: 'ceiling', version: '1' });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.instance.connect(a);
      await client.connect(b);
      try {
        const allowed = ceiling.includes('mcp__mitzo-web-access__RequestWebAccess');
        const result = await client.callTool({
          name: 'RequestWebAccess',
          arguments: { operation: 'search', query: 'offline', reason: 'fixture' },
        });
        expect(!!result.isError).toBe(!allowed);
        expect(execute).toHaveBeenCalledTimes(allowed ? 1 : 0);
        state.retired = true;
        expect(
          (
            await client.callTool({
              name: 'RequestWebAccess',
              arguments: { operation: 'search', query: 'offline', reason: 'fixture' },
            })
          ).isError,
        ).toBe(true);
        expect(execute).toHaveBeenCalledTimes(allowed ? 1 : 0);
      } finally {
        await client.close();
        await server.instance.close();
      }
    },
  );
  it('advertises and executes the same request schema through an SDK MCP server', async () => {
    const execute = vi.fn().mockResolvedValue({ content: 'answer', isError: false });
    const server = createWebAccessSdkServer(execute, new AbortController().signal);
    const client = new Client({ name: 'test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(a);
    await client.connect(b);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        'RequestWebAccess',
      ]);
      const args = { operation: 'search', query: 'Revenue', reason: 'Verify guidance' };
      expect(await client.callTool({ name: 'RequestWebAccess', arguments: args })).toMatchObject({
        content: [{ type: 'text', text: 'answer' }],
      });
      expect(execute).toHaveBeenCalledWith(args, expect.any(AbortSignal));
    } finally {
      await client.close();
      await server.instance.close();
    }
  });
  it('exposes GitHub publication through the same internally gated SDK server', async () => {
    const execute = vi.fn().mockResolvedValue({ content: 'published', isError: false });
    const server = createWebAccessSdkServer(vi.fn(), new AbortController().signal, execute);
    const client = new Client({ name: 'test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(a);
    await client.connect(b);
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toContain('RequestGithubPublish');
      const input = {
        repositoryPath: '/workspace',
        baseBranch: 'main',
        title: 'Publish',
        body: '',
        draft: true,
      };
      expect(
        await client.callTool({ name: 'RequestGithubPublish', arguments: input }),
      ).toMatchObject({ content: [{ type: 'text', text: 'published' }] });
      expect(execute).toHaveBeenCalledWith(
        input,
        expect.any(AbortSignal),
        expect.objectContaining({ turnId: expect.stringMatching(/^sdk:/) }),
      );
    } finally {
      await client.close();
      await server.instance.close();
    }
  });
  it.each(['current', 'retired', 'completing', 'ceiling-denied', 'authority-revoked'] as const)(
    'binds a fresh per-call publication fence for an ordinary query (%s)',
    async (condition) => {
      const state = createSdkCallbackState();
      const ceiling = new Set(
        condition === 'ceiling-denied' ? [] : ['mcp__mitzo-web-access__RequestGithubPublish'],
      );
      state.bindCommandToolAuthority({
        commandId: 'original',
        checkTool: (name) => (ceiling.has(name) ? 'allow' : 'deny'),
      });
      let revoked = false;
      const authority = vi.fn((signal: AbortSignal) => {
        signal.throwIfAborted();
        if (revoked) throw Error('Original Claude authority revoked');
      });
      const fences: AbortSignal[] = [];
      const publish = vi.fn(
        async (
          _input: unknown,
          _signal: AbortSignal,
          call: { turnId: string; callId: string; assertCurrentSync?(): void },
        ) => {
          call.assertCurrentSync!();
          return { content: 'published', isError: false };
        },
      );
      const server = createWebAccessSdkServer(
        vi.fn(),
        new AbortController().signal,
        publish,
        state.runCallback,
        (name) => state.checkTool(name),
        (signal) => {
          fences.push(signal);
          return () => {
            if (state.retired || state.completing) throw Error('Completed SDK query retired');
            if (state.checkTool('mcp__mitzo-web-access__RequestGithubPublish') !== 'allow')
              throw Error('Tool not allowed by the frozen command skill ceiling');
            authority(signal);
          };
        },
      );
      const client = new Client({ name: 'publish-fence', version: '1' });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.instance.connect(a);
      await client.connect(b);
      const args = {
        repositoryPath: '/workspace',
        baseBranch: 'main',
        title: 'Publish',
        body: '',
        draft: true,
      };
      try {
        if (condition === 'retired') state.retired = true;
        if (condition === 'completing') state.completing = true;
        if (condition === 'authority-revoked') revoked = true;
        const result = await client.callTool({ name: 'RequestGithubPublish', arguments: args });
        expect(!!result.isError).toBe(condition !== 'current');
        if (condition !== 'current') {
          expect(publish).not.toHaveBeenCalled();
          return;
        }
        expect(publish).toHaveBeenCalledOnce();
        const call = publish.mock.calls[0][2];
        expect(call).toMatchObject({
          turnId: expect.stringMatching(/^sdk:/),
          callId: expect.any(String),
          assertCurrentSync: expect.any(Function),
        });
        // A second call receives its own fence bound to its own call signal.
        await client.callTool({ name: 'RequestGithubPublish', arguments: args });
        expect(fences).toHaveLength(2);
        expect(fences[0]).not.toBe(fences[1]);
        expect(publish.mock.calls[1][2].assertCurrentSync).not.toBe(call.assertCurrentSync);
        // The earlier call's fence never outlives its query's retirement.
        state.retired = true;
        expect(() => call.assertCurrentSync!()).toThrow(/retired/);
      } finally {
        await client.close();
        await server.instance.close();
      }
    },
  );
  it('avoids a duplicate outer approval only for the exact internally gated tool', async () => {
    const decide = vi.fn().mockResolvedValue({ behavior: 'deny', message: 'deny' });
    const wrapped = webAccessSdkPermission(decide);
    const opts = { signal: new AbortController().signal, toolUseID: 'call' };
    expect(await wrapped('mcp__mitzo-web-access__RequestWebAccess', {}, opts)).toMatchObject({
      behavior: 'allow',
    });
    expect(decide).not.toHaveBeenCalled();
    await wrapped('mcp__other__RequestWebAccess', {}, opts);
    await wrapped('WebSearch', {}, opts);
    expect(decide).toHaveBeenCalledTimes(2);
  });
});
