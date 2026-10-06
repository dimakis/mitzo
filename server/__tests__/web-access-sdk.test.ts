import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWebAccessSdkServer, webAccessSdkPermission } from '../web-access-sdk.js';
describe('Claude SDK web access surface', () => {
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
        expect.objectContaining({ turnId: 'sdk' }),
      );
    } finally {
      await client.close();
      await server.instance.close();
    }
  });
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
