// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { createMitzoStore, WS_READY_STATE, type WebSocketLike } from '@mitzo/client';
import { briefingCommandHandoff, localBriefingConversation } from '../../lib/briefing-registration';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({
  apiFetch: vi.fn(),
  getApiBaseUrl: () => '',
  AUTH_LOST_EVENT: 'mitzo:auth-lost',
}));
const source = {
  kind: 'briefing' as const,
  date: '2026-10-09',
  revision: 'a'.repeat(64),
  content: 'Captured original briefing',
};
const selection = { accountId: 'work', model: 'luna', reasoningEffort: 'low' };
class Socket implements WebSocketLike {
  readyState: number = WS_READY_STATE.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: Record<string, unknown>[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = WS_READY_STATE.CLOSED;
    this.onclose?.();
  }
  emit(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  open() {
    this.readyState = WS_READY_STATE.OPEN;
    this.onopen?.({});
    this.emit({ type: 'welcome', protocolVersion: 2, connectionId: 'socket-1' });
  }
}
function ready() {
  const socket = new Socket();
  vi.mocked(apiFetch).mockResolvedValue(new Response('[]'));
  const store = createMitzoStore({
    transport: { fetch: apiFetch },
    wsConfig: { buildUrl: () => 'ws://fixture.test', createWebSocket: () => socket },
    sendHandoff: briefingCommandHandoff,
  });
  socket.open();
  return { store, socket };
}
afterEach(() => {
  localStorage.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});
it.each(['correlated', 'legacy'] as const)(
  'allows reader retry after a definitive %s WebSocket startup rejection',
  async (kind) => {
    vi.useFakeTimers();
    const { store, socket } = ready();
    store.getState().setPendingSession({
      prompt: 'Discuss saved report',
      context: 'Briefing',
      sourceSnapshots: [source],
      accountSelection: selection,
      briefing: { date: source.date, revision: source.revision },
    });
    store.getState().sendPendingSession();
    const command = socket.sent.find((message) => message.type === 'send')!;
    expect(command.sourceSnapshots).toEqual([source]);
    await expect(localBriefingConversation(source, selection)).rejects.toThrow(
      'awaiting assignment',
    );
    socket.emit({
      type: 'error',
      error: 'Account verification rejected',
      ...(kind === 'correlated' ? { clientMsgId: command.clientMsgId } : {}),
    });
    await expect(localBriefingConversation(source, selection)).resolves.toBeNull();
    expect(Object.keys(localStorage).filter((key) => key.includes('-commands:'))).toEqual([]);
    expect(store.getState().pendingSessionSending).toBe(false);
    expect(store.getState().pendingSession?.sourceSnapshots).toEqual([source]);
    store.getState().sendPendingSession();
    const sends = socket.sent.filter((message) => message.type === 'send');
    expect(sends).toHaveLength(2);
    expect(sends[1].clientMsgId).not.toBe(command.clientMsgId);
    expect(sends[1].sourceSnapshots).toEqual([source]);
  },
);
it('retains original pending identity across unrelated error and ambiguous network loss', async () => {
  vi.useFakeTimers();
  const { store, socket } = ready();
  store.getState().sendMessage('Discuss saved report', { ...selection, sourceSnapshots: [source] });
  const command = socket.sent.find((message) => message.type === 'send')!;
  socket.emit({
    type: 'error',
    clientMsgId: 'unrelated-command',
    error: 'Different startup rejected',
  });
  await expect(localBriefingConversation(source, selection)).rejects.toThrow('awaiting assignment');
  socket.close();
  await expect(localBriefingConversation(source, selection)).rejects.toThrow('awaiting assignment');
  const receipts = Object.keys(localStorage).filter((key) => key.includes('-commands:'));
  expect(receipts).toHaveLength(1);
  expect(JSON.parse(localStorage.getItem(receipts[0])!).clientMsgId).toBe(command.clientMsgId);
});

it('clears only the correlated rejected launch when another reviewed command is pending', async () => {
  vi.useFakeTimers();
  const { store, socket } = ready();
  const other = { ...source, date: '2026-10-10', revision: 'b'.repeat(64) };
  store.getState().sendMessage('First saved report', { ...selection, sourceSnapshots: [source] });
  store.getState().sendMessage('Second saved report', { ...selection, sourceSnapshots: [other] });
  const commands = socket.sent.filter((message) => message.type === 'send');
  expect(commands).toHaveLength(2);
  socket.emit({
    type: 'error',
    clientMsgId: commands[0].clientMsgId,
    error: 'First startup rejected',
  });
  await expect(localBriefingConversation(source, selection)).resolves.toBeNull();
  await expect(localBriefingConversation(other, selection)).rejects.toThrow('awaiting assignment');
  const retained = Object.keys(localStorage).filter((key) => key.includes('-commands:'));
  expect(retained).toHaveLength(1);
  expect(JSON.parse(localStorage.getItem(retained[0])!).clientMsgId).toBe(commands[1].clientMsgId);
});
