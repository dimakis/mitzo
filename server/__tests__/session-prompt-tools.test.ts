import { afterEach, expect, it, vi } from 'vitest';
import { SessionRegistry } from '@mitzo/harness';
import { randomUUID } from 'node:crypto';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import { bindAgentToolSelection } from '../agent-tool-selection.js';
import { sessionPromptTools } from '../session-prompt-tools.js';
import { agentToolCatalog } from '../agent-tool-catalog.js';

const f = vi.hoisted(() => ({
  create: vi.fn(async () => ({ id: 'timer', status: 'active' })),
  send: vi.fn(async () => ({ id: 'message', state: 'pending' })),
  change: vi.fn(),
  list: vi.fn(() => []),
  sessions: vi.fn(async () => []),
  approve: vi.fn(async (_name: string, input: Record<string, unknown>) => ({
    behavior: 'allow',
    updatedInput: input,
  })),
}));
vi.mock('../session-prompt-runtime.js', () => ({ getSessionPrompts: () => f }));
vi.mock('../permission-handler.js', () => ({ buildPermissionHandler: () => f.approve }));
const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
  vi.clearAllMocks();
});
function fixture(signed = true) {
  const registry = new SessionRegistry();
  cleanup.push(() => registry.dispose());
  registry.register('operator:worker', {
    transport: { send() {}, isOpen: () => true },
    abortController: new AbortController(),
    sessionId: 'worker',
    mode: 'agent',
    sessionAllowList: new Set(),
  });
  const session = registry.get('operator:worker')!;
  if (signed)
    cleanup.push(
      bindAgentLibraryTransport('operator', { id: 'login', expiresAt: Date.now() + 60000 }),
    );
  const tools = sessionPromptTools(
    'worker',
    session,
    registry,
    '',
    async () => {},
    () => {},
  );
  return {
    tools,
    registry,
    session,
    call: { turnId: 'turn', callId: 'verified-call' },
    signal: new AbortController().signal,
  };
}
it('uses verified runtime source for agent timers and callbacks and preserves ordinary approval', async () => {
  const x = fixture();
  const input = { requestId: randomUUID(), prompt: 'Check PR #7', intervalMinutes: 10 };
  expect((await x.tools.execute('SchedulePrompt', input, x.signal, x.call))?.isError).toBe(false);
  expect(f.create).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: 'worker' }),
    expect.objectContaining({ id: 'login' }),
    'agent',
    'worker',
    expect.any(Function),
  );
  const message = {
    requestId: randomUUID(),
    sessionId: 'coordinator',
    text: 'Task T finished.',
    workId: 'T',
  };
  expect((await x.tools.execute('SendSessionMessage', message, x.signal, x.call))?.isError).toBe(
    false,
  );
  expect(f.send).toHaveBeenCalledWith(
    message,
    expect.objectContaining({ id: 'login' }),
    'worker',
    expect.any(Function),
  );
  expect(f.approve).toHaveBeenCalledTimes(2);
});
it('rejects missing signed actor, forged source, missing call identity, and deselected tools', async () => {
  const x = fixture(false),
    input = { requestId: randomUUID(), sessionId: 'other', text: 'Hello' };
  expect((await x.tools.execute('SendSessionMessage', input, x.signal, x.call))?.isError).toBe(
    true,
  );
  cleanup.push(
    bindAgentLibraryTransport('operator', { id: 'login', expiresAt: Date.now() + 60000 }),
  );
  expect(
    (
      await x.tools.execute(
        'SendSessionMessage',
        { ...input, senderSessionId: 'forged' },
        x.signal,
        x.call,
      )
    )?.isError,
  ).toBe(true);
  expect((await x.tools.execute('SendSessionMessage', input, x.signal))?.isError).toBe(true);
  bindAgentToolSelection(x.session, { tools: [] } as never);
  expect((await x.tools.execute('SendSessionMessage', input, x.signal, x.call))?.isError).toBe(
    true,
  );
  expect(f.send).not.toHaveBeenCalled();
});
it('keeps listings read-only and makes task and session tools selectable across ordinary host routes', async () => {
  const x = fixture();
  expect((await x.tools.execute('SessionTimers', { operation: 'list' }, x.signal))?.isError).toBe(
    false,
  );
  expect(f.approve).not.toHaveBeenCalled();
  for (const name of ['TaskExecution', 'SchedulePrompt', 'SessionTimers', 'SendSessionMessage'])
    expect(agentToolCatalog().find((tool) => tool.name === name)?.routes).toEqual([
      'local-api',
      'codex',
      'codex-owned-local',
    ]);
});
