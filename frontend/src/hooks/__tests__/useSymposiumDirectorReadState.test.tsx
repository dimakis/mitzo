// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DirectorStatus } from '../../types/symposium-director';
import { useSymposiumDirectorReadState } from '../useSymposiumDirectorReadState';

afterEach(cleanup);

function savedStatus(sessionId = 'session'): DirectorStatus {
  return {
    sessionId,
    config: {
      version: 2,
      revision: 4,
      state: 'active',
      anchorSeatId: 'architect',
      activeSeatCap: 3,
      seats: [],
      turnRules: { mode: 'directed', maxTurns: 8 },
      interceptMode: 'manual',
    },
    seats: [
      {
        seatId: 'architect',
        seat: {
          id: 'architect',
          name: 'Architect',
          role: 'architect',
          model: 'offline',
          systemPrompt: '',
          color: 'var(--seat-color-1)',
        },
        membership: {
          sessionId,
          seatId: 'architect',
          generation: 1,
          state: 'active',
          action: 'admit',
          configRevision: 4,
          bindingKey: 'binding',
          actor: 'user',
          reason: 'selected',
          idempotencyKey: 'member',
          occurredAt: 1,
          reconciliation: 'confirmed',
          replacesSeatId: null,
          replacedBySeatId: null,
        },
        admitted: false,
        admissionRecorded: true,
        savedRuntimeState: 'reserved',
        creationDiagnostic: { phase: 'mount', code: 'FAILED', canCleanup: false },
      },
    ],
    runtimeAvailable: false,
    statusMode: 'durable',
    runtimeVerification: 'not_checked',
    reservedSeats: 1,
    capacityRemaining: 2,
    deliveries: [],
  };
}

function freshDetails(sessionId = 'session'): DirectorStatus {
  const saved = savedStatus(sessionId);
  return {
    ...saved,
    statusMode: 'live',
    runtimeVerification: 'checked',
    runtimeAvailable: true,
    seats: saved.seats.map((seat) => ({
      ...seat,
      admitted: true,
      savedRuntimeState: 'ready',
      creationDiagnostic: { phase: 'upload', code: 'CURRENT', canCleanup: true },
    })),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture(
  readStatus = vi.fn(async (path: string) =>
    savedStatus(path.includes('/next/') ? 'next' : 'session'),
  ),
) {
  const onStatus = vi.fn();
  const onRefreshStart = vi.fn();
  const onDetailStart = vi.fn();
  const onReset = vi.fn();
  const mounted = renderHook(
    ({ sessionId, open }) =>
      useSymposiumDirectorReadState({
        sessionId,
        open,
        readStatus,
        onStatus,
        onRefreshStart,
        onDetailStart,
        onReset,
      }),
    { initialProps: { sessionId: 'session', open: true } },
  );
  return { ...mounted, readStatus, onStatus, onRefreshStart, onDetailStart, onReset };
}

it.each(['status', 'details'] as const)(
  'reads saved status automatically and reads %s only at its requested endpoint',
  async (read) => {
    const f = fixture();
    await waitFor(() => expect(f.result.current.status?.statusMode).toBe('durable'));
    expect(f.readStatus).toHaveBeenCalledExactlyOnceWith('/api/sessions/session/symposium/status');
    if (read === 'details') {
      f.readStatus.mockResolvedValueOnce(freshDetails());
      const saved = f.result.current.status!;
      await act(() => f.result.current.checkDetails(saved.seats[0]));
      expect(f.readStatus).toHaveBeenLastCalledWith('/api/sessions/session/symposium');
      expect(f.result.current.status).toEqual({
        ...saved,
        seats: [
          {
            ...saved.seats[0],
            creationDiagnostic: freshDetails().seats[0].creationDiagnostic,
          },
        ],
      });
      expect(f.onDetailStart).toHaveBeenCalledExactlyOnceWith('architect');
      expect(f.onStatus).toHaveBeenCalledTimes(1);
    }
  },
);

it.each(
  (['status', 'details'] as const).flatMap((read) =>
    (['refresh', 'close', 'navigation'] as const).flatMap((transition) =>
      (['success', 'error'] as const).map((completion) => ({ read, transition, completion })),
    ),
  ),
)(
  'suppresses late $read $completion after $transition',
  async ({ read, transition, completion }) => {
    const pending = deferred<DirectorStatus>();
    const readStatus = vi.fn(async (path: string) =>
      savedStatus(path.includes('/next/') ? 'next' : 'session'),
    );
    const f = fixture(readStatus);
    await waitFor(() => expect(f.result.current.loading).toBe(false));
    readStatus.mockReturnValueOnce(pending.promise);
    let old!: Promise<void>;
    act(() => {
      old =
        read === 'status'
          ? f.result.current.refresh()
          : f.result.current.checkDetails(f.result.current.status!.seats[0]);
    });
    if (transition === 'refresh') await act(() => f.result.current.refresh());
    else
      f.rerender({
        sessionId: transition === 'navigation' ? 'next' : 'session',
        open: transition !== 'close',
      });
    if (transition === 'navigation')
      await waitFor(() => expect(f.result.current.loading).toBe(false));
    if (transition === 'navigation') expect(f.result.current.status?.sessionId).toBe('next');
    const current = f.result.current.status;
    const statusCalls = f.onStatus.mock.calls.length;
    await act(async () => {
      if (completion === 'success') pending.resolve(freshDetails());
      else pending.reject(new Error('late failure'));
      await old;
    });
    expect(f.result.current.status).toBe(current);
    expect(f.result.current.error).toBe('');
    expect(f.result.current.detailChecks.architect?.error).toBeUndefined();
    expect(f.onStatus).toHaveBeenCalledTimes(statusCalls);
  },
);

it.each([
  'session',
  'revision',
  'generation',
  'seat',
  'durable',
  'unchecked',
  'unavailable',
  'diagnostic',
])(
  'retains the saved failure when fresh %s does not match the inspected status',
  async (changed) => {
    const f = fixture();
    await waitFor(() => expect(f.result.current.loading).toBe(false));
    const saved = f.result.current.status;
    const checked = freshDetails();
    if (changed === 'session') checked.sessionId = 'other';
    if (changed === 'revision' && checked.config) checked.config.revision++;
    if (changed === 'generation' && checked.seats[0].membership)
      checked.seats[0].membership.generation++;
    if (changed === 'seat') checked.seats[0].seatId = 'other';
    if (changed === 'durable') checked.statusMode = 'durable';
    if (changed === 'unchecked') checked.runtimeVerification = 'not_checked';
    if (changed === 'unavailable') checked.runtimeAvailable = false;
    if (changed === 'diagnostic') checked.seats[0].creationDiagnostic = null;
    f.readStatus.mockResolvedValueOnce(checked);
    await act(() => f.result.current.checkDetails(saved!.seats[0]));
    expect(f.result.current.status).toBe(saved);
    expect(f.result.current.detailChecks.architect.error).toBe(
      ['unavailable', 'diagnostic'].includes(changed)
        ? 'Current creation proof is unavailable. The saved failure is retained.'
        : 'Agent details changed. Refresh the agent list before continuing.',
    );
    expect(f.result.current.error).toBe('');
  },
);

it('revokes cleanup consent when refresh starts, on accepted status and on requested details', async () => {
  const pending = deferred<DirectorStatus>();
  const f = fixture();
  await waitFor(() => expect(f.result.current.loading).toBe(false));
  f.onRefreshStart.mockClear();
  f.onStatus.mockClear();
  f.readStatus.mockReturnValueOnce(pending.promise);
  let refreshing!: Promise<void>;
  act(() => {
    refreshing = f.result.current.refresh();
  });
  expect(f.onRefreshStart).toHaveBeenCalledTimes(1);
  expect(f.onStatus).not.toHaveBeenCalled();
  await act(async () => {
    pending.resolve(savedStatus());
    await refreshing;
  });
  expect(f.onStatus).toHaveBeenCalledExactlyOnceWith(f.result.current.status);
  f.readStatus.mockResolvedValueOnce(freshDetails());
  await act(() => f.result.current.checkDetails(f.result.current.status!.seats[0]));
  expect(f.onDetailStart).toHaveBeenCalledExactlyOnceWith('architect');
});

it('retains a mutation error and appends a failed status refresh without discarding the saved roster', async () => {
  const f = fixture();
  await waitFor(() => expect(f.result.current.loading).toBe(false));
  const saved = f.result.current.status;
  f.readStatus.mockRejectedValueOnce(new Error('host unavailable'));
  await act(() => f.result.current.refresh('cleanup requires recovery'));
  expect(f.result.current.error).toBe(
    'cleanup requires recovery. Status refresh failed: host unavailable',
  );
  expect(f.result.current.status).toBe(saved);
  expect(f.result.current.loading).toBe(false);
});
