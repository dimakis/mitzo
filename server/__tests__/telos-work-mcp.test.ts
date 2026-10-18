import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ register: vi.fn(), connect: vi.fn(), execute: vi.fn() }));
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    registerTool = mocks.register;
    connect = mocks.connect;
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));
vi.mock('../telos-work-tools.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../telos-work-tools.js')>()),
  executeTelosWorkTool: mocks.execute,
}));
const originalArgs = [...process.argv];
afterEach(() => {
  process.argv = [...originalArgs];
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.resetModules();
});

it('registers slice allocation through the shared executor only with an exact host-supplied session', async () => {
  process.argv = [
    'node',
    'telos-mcp-server',
    '--base-url',
    'http://host',
    '--client-id',
    'client',
    '--session-id',
    'lead',
  ];
  vi.stubEnv('MITZO_INTERNAL_TOKEN', 'secret');
  await import('../telos-mcp-server.js');
  const registration = mocks.register.mock.calls.find(([name]) => name === 'TelosStartSlice');
  expect(registration).toBeDefined();
  const input = {
    requestId: 'request',
    childItemId: 'child',
    mode: 'start',
    predecessorAttemptId: null,
  };
  mocks.execute.mockResolvedValue({ content: 'retained receipt', isError: false });
  expect(await registration![2](input)).toEqual({
    content: [{ type: 'text', text: 'retained receipt' }],
  });
  expect(mocks.execute).toHaveBeenCalledWith(
    'http://host',
    'client',
    'lead',
    'secret',
    'TelosStartSlice',
    input,
  );
});

it('keeps legacy Telos MCP tools while withholding delegation when session identity is absent', async () => {
  process.argv = ['node', 'telos-mcp-server', '--base-url', 'http://host', '--client-id', 'client'];
  vi.stubEnv('MITZO_INTERNAL_TOKEN', 'secret');
  await import('../telos-mcp-server.js');
  const names = mocks.register.mock.calls.map(([name]) => name);
  expect(names).toContain('TelosGetItem');
  expect(names).not.toContain('TelosStartSlice');
});
