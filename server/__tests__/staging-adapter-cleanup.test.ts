import { expect, it, vi } from 'vitest';
import { connectCodexMcpTools } from '../codex-mcp-tools.js';
it('keeps original MCP shutdown acknowledgment and refuses a failed peer', async () => {
  let finish!: () => void;
  const peer = {
    listTools: vi.fn(async () => ({ tools: [] })),
    callTool: vi.fn(),
    close: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    ),
  };
  const tools = await connectCodexMcpTools(
    { fixture: { command: 'fixture' } },
    { cwd: '/tmp', env: {}, signal: new AbortController().signal, connect: async () => peer },
  );
  void tools.close();
  const confirmed = tools.confirmClosed();
  let settled = false;
  void confirmed.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  finish();
  await expect(confirmed).resolves.toBeUndefined();
  expect(peer.close).toHaveBeenCalledOnce();
  const failed = await connectCodexMcpTools(
    { fixture: { command: 'fixture' } },
    {
      cwd: '/tmp',
      env: {},
      signal: new AbortController().signal,
      connect: async () => ({
        ...peer,
        close: async () => {
          throw new Error('private');
        },
      }),
    },
  );
  await expect(failed.confirmClosed()).rejects.toThrow('Owned MCP cleanup is unconfirmed');
});
