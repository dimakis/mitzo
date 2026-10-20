// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { ChatView } from '../ChatView';
import { DesktopChatView } from '../DesktopChatView';
import { createTestStore } from '../../test-utils/createTestStore';
import { joiningApplicationHarness } from '../../test-utils/conversation-joining-application-harness';
import * as auth from '../../lib/api-fetch';

type Input = {
  onSend(text: string): boolean;
  onInterrupt?(
    text: string,
    images?: never[],
    context?: string[],
    receipt?: (status: string) => void,
  ): void;
  sendDisabledReason?: string;
};
const inputs = vi.hoisted(() => ({ current: null as Input | null, unexpected: new Set<string>() }));
vi.mock('../../components/ChatInput', () => ({
  ChatInput: (props: Input) => {
    inputs.current = props;
    return <button disabled={!!props.sendDisabledReason}>Send fixture draft</button>;
  },
}));
vi.mock('../../lib/event-bus-singleton', () => ({
  eventBus: {
    on: vi.fn(() => vi.fn()),
    onConnectionChange: vi.fn(() => vi.fn()),
    connected: false,
  },
}));
vi.mock('../../components/ChatArea', () => ({ ChatArea: () => null }));
vi.mock('../../components/SessionPanel', () => ({ SessionPanel: () => null }));
vi.mock('../../components/CommandCenter', () => ({ CommandCenter: () => null }));
vi.mock('../../components/DesktopShell', () => ({
  DesktopShell: ({ center, right }: { center: React.ReactNode; right: React.ReactNode }) => (
    <>
      {center}
      {right}
    </>
  ),
}));
vi.mock('../../components/ChatAgentProfilePicker', () => ({ ChatAgentProfilePicker: () => null }));
vi.mock('../../components/RepositoryChatPicker', () => ({ RepositoryChatPicker: () => null }));
vi.mock('../../components/VoiceSettings', () => ({ VoiceSettings: () => null }));
vi.mock('../../components/WebSearchConsent', () => ({ WebSearchConsent: () => null }));
vi.mock('../../hooks/useHomePreferences', () => ({
  useHomePreferences: () => ({ preferences: { names: { briefing: 'Jeeves' } } }),
}));
vi.mock('../../hooks/useProgress', () => ({ useProgressByToolId: () => new Map() }));
vi.mock('../../hooks/useVoice', () => ({
  useVoice: () => ({ available: false, stopSpeaking: vi.fn(), voices: [] }),
}));
vi.mock('../../hooks/useBriefingChat', () => ({ useBriefingChat: () => ({}) }));
vi.mock('../../lib/keyboard', () => ({ onKeyboardToggle: () => () => {} }));
vi.mock('../../lib/haptics', () => ({ impactMedium: vi.fn() }));
// Actual verified cookie owner and joining apiFetch/client remain installed.
// Other ordinary page reads have explicit inert fixture responses.
vi.mock('../../lib/api-fetch', async (original) => {
  const real = await original<typeof import('../../lib/api-fetch')>();
  return {
    ...real,
    apiFetch: vi.fn((input: string, init?: RequestInit) => {
      const path = new URL(input, 'https://offline.invalid').pathname;
      if (
        path.startsWith('/api/session-collaborations/') ||
        path === '/api/chat/runtime/capabilities'
      )
        return real.apiFetch(input, init);
      if (path === '/api/sessions/source-chat/meta')
        return Promise.resolve(
          Response.json({
            sessionType: 'chat',
            accountBinding: {
              accountId: 'personal',
              accountLabel: 'Personal',
              model: 'luna-fixture',
            },
            modelSelection: {
              model: 'luna-fixture',
              models: [{ id: 'luna-fixture', label: 'Luna' }],
            },
          }),
        );
      if (path === '/api/sessions/source-chat/symposium/status')
        return Promise.resolve(
          Response.json({ sessionId: 'source-chat', config: null, seats: [] }),
        );
      if (path === '/api/sessions/source-chat/compactions')
        return Promise.resolve(Response.json([]));
      inputs.unexpected.add(path);
      throw Error(`Unexpected page fixture request: ${path}`);
    }),
  };
});

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  auth.markAuthLost();
  inputs.current = null;
  inputs.unexpected.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ok: true, authSessionId: 'target-owner-login' })),
  );
  await auth.restoreCookieAuthentication();
});
afterEach(() => {
  cleanup();
  auth.markAuthLost();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function mount(Page: typeof ChatView) {
  const store = createTestStore();
  const send = vi.fn(() => true),
    interrupt = vi.fn();
  store.setState({
    sessions: { ...store.getState().sessions, active: 'source-chat' },
    connection: { status: 'connected', clientId: 'live-client' },
    sendMessage: send,
    interruptMessage: interrupt,
    fetchSessionMeta: vi.fn().mockResolvedValue(undefined),
  });
  const rendered = render(
    <MemoryRouter initialEntries={['/chat/source-chat']}>
      <Routes>
        <Route
          path="/chat/:sessionId"
          element={
            <MitzoStoreProvider value={store}>
              <Page />
            </MitzoStoreProvider>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return { ...rendered, send, interrupt, store };
}

/** Actual pages + genuine verified-auth getter + typed membership readers.
 * Ordinary transport actions are recording spies; no model/native/backend execution. */
for (const Page of [ChatView, DesktopChatView]) {
  it(`${Page.name} interlocks its callbacks through deferred membership and same-ID restoration`, async () => {
    const h = joiningApplicationHarness();
    const pending = gate();
    h.after((path) =>
      path === '/api/session-collaborations/source-setup' ? pending.promise : undefined,
    );
    const page = mount(Page);
    expect(auth.currentVerifiedAuthSessionId()).toBe('target-owner-login');
    expect(
      ((await screen.findByRole('button', { name: 'Send fixture draft' })) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    const initial = inputs.current!;
    expect(initial.onSend('Preserved draft')).toBe(false);
    expect(initial.onInterrupt).toBeUndefined();
    expect(page.send).not.toHaveBeenCalled();
    await act(async () => pending.resolve());
    await waitFor(() => expect(inputs.current?.sendDisabledReason).toBeUndefined());
    const confirmed = inputs.current!;
    expect(confirmed.onInterrupt).toBeTypeOf('function');
    // Confirm the same ordinary callbacks are usable before they are retired.
    act(() => {
      expect(confirmed.onSend('Ordinary prompt')).toBe(true);
      confirmed.onInterrupt?.('Ordinary interrupt');
    });
    expect(page.send).toHaveBeenCalledTimes(1);
    expect(page.interrupt).toHaveBeenCalledTimes(1);
    const restored = gate();
    h.after((path) =>
      path === '/api/session-collaborations/source-setup' ? restored.promise : undefined,
    );
    const storage = () =>
      Object.fromEntries(
        Object.keys(localStorage)
          .filter((key) => key.startsWith('mitzo-chat-draft:'))
          .map((key) => [key, localStorage.getItem(key)]),
      );
    const draftStorage = storage();
    await act(async () => {
      auth.markAuthLost();
      await auth.restoreCookieAuthentication();
    });
    const receipt = vi.fn();
    act(() => {
      expect(confirmed.onSend('Retired prompt')).toBe(false);
      confirmed.onInterrupt?.('Retired interrupt', undefined, undefined, receipt);
    });
    expect(receipt).toHaveBeenCalledWith('failed');
    expect(page.send).toHaveBeenCalledTimes(1);
    expect(page.interrupt).toHaveBeenCalledTimes(1);
    expect(inputs.current?.sendDisabledReason).toBeTruthy();
    await act(async () => restored.resolve());
    await waitFor(() => expect(inputs.current?.sendDisabledReason).toBeUndefined());
    expect(confirmed.onSend('Still retired')).toBe(false);
    expect(storage()).toEqual(draftStorage);
    expect(h.journal.readBegin()).toBeNull();
    expect(h.journal.readTarget()).toBeNull();
    expect([...inputs.unexpected]).toEqual([]);
  });

  it(`${Page.name} keeps failed and reloaded multi-member source reads from ordinary source dispatch`, async () => {
    const h = joiningApplicationHarness('00000000-0000-4000-8000-000000000010', [
      'source-chat',
      'peer',
    ]);
    h.after((path) => {
      if (path === '/api/session-collaborations/source-setup')
        throw Error('Membership read failed');
    });
    const first = mount(Page);
    await waitFor(() =>
      expect(h.transport.mock.calls.some(([url]) => url.includes('/source-setup'))).toBe(true),
    );
    expect(inputs.current!.onSend('Keep draft')).toBe(false);
    expect(inputs.current!.onInterrupt).toBeUndefined();
    expect(first.send).not.toHaveBeenCalled();
    first.unmount();
    const pending = gate();
    h.after((path) =>
      path === '/api/session-collaborations/source-setup' ? pending.promise : undefined,
    );
    const reloaded = mount(Page);
    expect(inputs.current!.onSend('Still preserved')).toBe(false);
    await act(async () => pending.resolve());
    await waitFor(() => expect(inputs.current?.sendDisabledReason).toContain('Shared discussion'));
    expect(inputs.current!.onSend('No source fallback')).toBe(false);
    expect(reloaded.send).not.toHaveBeenCalled();
    expect(reloaded.interrupt).not.toHaveBeenCalled();
    expect([...inputs.unexpected]).toEqual([]);
  });
}
