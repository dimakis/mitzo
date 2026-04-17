// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { createMitzoStore } from '@mitzo/client';
import type { WebSocketLike } from '@mitzo/client';
import { WS_READY_STATE } from '@mitzo/client';
import { useTaskBoard } from '../useTaskBoard';

class MockWebSocket implements WebSocketLike {
  readyState: number = WS_READY_STATE.CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = WS_READY_STATE.CLOSED;
  }
  simulateOpen() {
    this.readyState = WS_READY_STATE.OPEN;
    this.onopen?.({});
  }
  simulateMessage(msg: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

let lastWs: MockWebSocket;

function setup() {
  const store = createMitzoStore({
    transport: {
      fetch: vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tasks: [] }),
        text: () => Promise.resolve(''),
      }),
    },
    wsConfig: {
      buildUrl: () => 'ws://localhost/ws',
      createWebSocket: () => {
        lastWs = new MockWebSocket();
        return lastWs;
      },
    },
  });

  lastWs.simulateOpen();
  lastWs.simulateMessage({ type: 'welcome', protocolVersion: 2, connectionId: 'c1' });

  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(MitzoStoreProvider, { value: store }, children);

  return { store, wrapper };
}

describe('useTaskBoard', () => {
  afterEach(cleanup);

  it('returns loading=true initially and tasks from the store', async () => {
    const { wrapper } = setup();

    // Pre-populate tasks via WS
    lastWs.simulateMessage({
      type: 'task_state',
      tasks: [{ id: 't1', title: 'Task 1', status: 'pending', children: [] }],
    });

    const { result } = renderHook(() => useTaskBoard(), { wrapper });

    await waitFor(() => {
      expect(result.current.tasks).toHaveLength(1);
      expect(result.current.tasks[0].id).toBe('t1');
    });
  });

  it('provides loopStatus from the store', async () => {
    const { wrapper } = setup();

    lastWs.simulateMessage({
      type: 'loop_status',
      state: 'running',
      goalId: 'g1',
      activeTaskId: null,
      progress: null,
      specMode: false,
      awaitingApproval: false,
    });

    const { result } = renderHook(() => useTaskBoard(), { wrapper });

    await waitFor(() => {
      expect(result.current.loopStatus.state).toBe('running');
      expect(result.current.loopStatus.goalId).toBe('g1');
    });
  });

  it('exposes CRUD action functions', () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useTaskBoard(), { wrapper });

    expect(typeof result.current.createTask).toBe('function');
    expect(typeof result.current.deleteTask).toBe('function');
    expect(typeof result.current.startLoop).toBe('function');
    expect(typeof result.current.refresh).toBe('function');
  });
});
