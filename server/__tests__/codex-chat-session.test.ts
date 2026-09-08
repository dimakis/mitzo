import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  close: vi.fn(),
  send: vi.fn(),
  mcpClose: vi.fn(),
  connect: vi.fn(),
  store: vi.fn(),
}));
vi.mock('../codex-conversation-store.js', () => ({
  CodexConversationStore: class {
    constructor() {
      mocks.store();
    }
    recoverAtStartup() {}
  },
}));
vi.mock('../codex-conversation.js', () => ({
  CodexConversation: class {
    constructor(options: { onClosed: () => void }) {
      mocks.close.mockImplementation(options.onClosed);
    }
    initialize = mocks.initialize;
    close = mocks.close;
    send = mocks.send;
  },
}));
vi.mock('../codex-mcp-tools.js', () => ({ connectCodexMcpTools: mocks.connect }));
vi.mock('../codex-private-path.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../codex-private-path.js')>()),
  codexPrivateDirectory: () => '/tmp',
}));
import { openCodexChat } from '../codex-chat-session.js';
function options(abortController: AbortController) {
  return { session: { cwd: '/tmp', abortController }, mcpServers: {} } as Parameters<
    typeof openCodexChat
  >[0];
}
it('does not open MCP processes if private storage is unavailable', async () => {
  mocks.store.mockImplementationOnce(() => {
    throw new Error('storage unavailable');
  });
  mocks.connect.mockResolvedValue({ definitions: [], close: mocks.mcpClose });
  await expect(openCodexChat(options(new AbortController()))).rejects.toThrow(
    'storage unavailable',
  );
  expect(mocks.connect).not.toHaveBeenCalled();
});
it('closes an initialization aborted before the first turn starts', async () => {
  const abort = new AbortController();
  mocks.connect.mockResolvedValue({ definitions: [], close: mocks.mcpClose });
  mocks.initialize.mockImplementationOnce(async () => {
    abort.abort();
  });
  await expect(openCodexChat(options(abort))).rejects.toThrow();
  expect(mocks.close).toHaveBeenCalled();
  expect(mocks.mcpClose).toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});

it('cleans each resource once across explicit close, runtime close and abort', async () => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue({ definitions: [], close: mocks.mcpClose });
  const abort = new AbortController();
  const chat = await openCodexChat(options(abort));
  chat.close();
  chat.close();
  abort.abort();
  expect(mocks.close).toHaveBeenCalledTimes(1);
  expect(mocks.mcpClose).toHaveBeenCalledTimes(1);
});
