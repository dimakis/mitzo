// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChatActions } from '../useChatActions';

vi.mock('../../lib/ws-pool', () => ({
  wsIsOpen: vi.fn(),
  wsSend: vi.fn(),
  wsSetRunning: vi.fn(),
}));

import { wsIsOpen, wsSend, wsSetRunning } from '../../lib/ws-pool';

function makeDeps(overrides: Partial<Parameters<typeof useChatActions>[0]> = {}) {
  return {
    poolKey: 'session:test-123',
    sessionState: {
      model: 'claude-sonnet-4-6',
      mode: 'agent' as const,
      currentSessionId: 'test-123',
    },
    searchParams: new URLSearchParams(),
    dispatch: vi.fn(),
    pendingSend: { current: null },
    forceScrollToBottom: vi.fn(),
    voice: { stopSpeaking: vi.fn() },
    running: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (wsIsOpen as ReturnType<typeof vi.fn>).mockReturnValue(true);
});

describe('useChatActions', () => {
  it('dispatches CONNECTION_LOST when WS is closed', () => {
    (wsIsOpen as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const deps = makeDeps();
    const { result } = renderHook(() => useChatActions(deps));

    const sent = result.current.sendMessage('hello');

    expect(sent).toBe(false);
    expect(deps.dispatch).toHaveBeenCalledWith({ type: 'CONNECTION_LOST' });
    expect(wsSend).not.toHaveBeenCalled();
  });

  it('sends message and dispatches USER_SEND', () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useChatActions(deps));

    const sent = result.current.sendMessage('hello');

    expect(sent).toBe(true);
    expect(wsSend).toHaveBeenCalledWith(
      'session:test-123',
      expect.objectContaining({ type: 'send', prompt: 'hello', model: 'claude-sonnet-4-6' }),
    );
    expect(deps.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'USER_SEND', text: 'hello' }),
    );
    expect(deps.forceScrollToBottom).toHaveBeenCalled();
    expect(deps.voice.stopSpeaking).toHaveBeenCalled();
  });

  it('calls wsSetRunning only when not already running', () => {
    const deps = makeDeps({ running: false });
    const { result } = renderHook(() => useChatActions(deps));

    result.current.sendMessage('hello');
    expect(wsSetRunning).toHaveBeenCalledWith('session:test-123', true);
  });

  it('does not call wsSetRunning when already running', () => {
    const deps = makeDeps({ running: true });
    const { result } = renderHook(() => useChatActions(deps));

    result.current.sendMessage('hello');
    expect(wsSetRunning).not.toHaveBeenCalled();
  });

  it('forwards contextBlocks in payload', () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useChatActions(deps));

    result.current.sendMessage('hello', undefined, ['boot-context']);

    expect(wsSend).toHaveBeenCalledWith(
      'session:test-123',
      expect.objectContaining({ contextBlocks: ['boot-context'] }),
    );
  });

  it('includes resume when currentSessionId exists', () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useChatActions(deps));

    result.current.sendMessage('hello');

    expect(wsSend).toHaveBeenCalledWith(
      'session:test-123',
      expect.objectContaining({ resume: 'test-123' }),
    );
  });

  it('interruptMessage is guarded by running state', () => {
    const deps = makeDeps({ running: false });
    const { result } = renderHook(() => useChatActions(deps));

    result.current.interruptMessage('stop that');

    expect(wsSend).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('interruptMessage sends when running', () => {
    const deps = makeDeps({ running: true });
    const { result } = renderHook(() => useChatActions(deps));

    result.current.interruptMessage('stop that');

    expect(wsSend).toHaveBeenCalledWith(
      'session:test-123',
      expect.objectContaining({ type: 'interrupt', prompt: 'stop that' }),
    );
    expect(deps.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'USER_SEND', text: 'stop that' }),
    );
  });

  it('handleStop sends stop and resets running', () => {
    const deps = makeDeps({ running: true });
    const { result } = renderHook(() => useChatActions(deps));

    act(() => result.current.handleStop());

    expect(wsSend).toHaveBeenCalledWith('session:test-123', { type: 'stop' });
    expect(wsSetRunning).toHaveBeenCalledWith('session:test-123', false);
    expect(deps.dispatch).toHaveBeenCalledWith({ type: 'SET_RUNNING', running: false });
  });

  it('forwards cwd and extraTools from searchParams', () => {
    const params = new URLSearchParams({ cwd: '/my/dir', extraTools: 'Bash' });
    const deps = makeDeps({ searchParams: params });
    const { result } = renderHook(() => useChatActions(deps));

    result.current.sendMessage('hello');

    expect(wsSend).toHaveBeenCalledWith(
      'session:test-123',
      expect.objectContaining({ cwd: '/my/dir', extraTools: 'Bash' }),
    );
  });
});
