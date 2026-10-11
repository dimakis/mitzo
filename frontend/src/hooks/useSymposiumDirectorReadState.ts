import { useCallback, useEffect, useRef, useState } from 'react';
import type { DirectorSeat, DirectorStatus } from '../types/symposium-director';

interface DirectorReadDependencies {
  sessionId: string;
  open: boolean;
  readStatus(path: string): Promise<DirectorStatus>;
  /** Reconcile exact durable receipts before publishing the read. */
  onStatusRead?(status: DirectorStatus): void;
  /** The component retains form, selection and typed-consent ownership. */
  onStatus(status: DirectorStatus): void;
  onRefreshStart(): void;
  onDetailStart(seatId: string): void;
  onReset(): void;
}

/** Saved roster reads and requested physical details share one refresh fence.
 * Commands, admission receipts and page-lifetime activation remain with their owners. */
export function useSymposiumDirectorReadState({
  sessionId,
  open,
  readStatus,
  onStatusRead,
  onStatus,
  onRefreshStart,
  onDetailStart,
  onReset,
}: DirectorReadDependencies) {
  const [status, setStatus] = useState<DirectorStatus | null>(null);
  const [detailChecks, setDetailChecks] = useState<
    Record<string, { pending: boolean; error?: string }>
  >({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const refreshGeneration = useRef(0);
  const base = `/api/sessions/${encodeURIComponent(sessionId)}/symposium`;

  const refresh = useCallback(
    async (preservedError?: string) => {
      const generation = ++refreshGeneration.current;
      setLoading(true);
      setDetailChecks({});
      onRefreshStart();
      try {
        const next = await readStatus(`${base}/status`);
        if (generation !== refreshGeneration.current) return;
        onStatusRead?.(next);
        setStatus(next);
        setDetailChecks({});
        onStatus(next);
        setError(preservedError ?? '');
      } catch (cause) {
        if (generation === refreshGeneration.current) {
          const refreshError =
            cause instanceof Error ? cause.message : 'Director status unavailable';
          setError(
            preservedError
              ? `${preservedError}. Status refresh failed: ${refreshError}`
              : refreshError,
          );
        }
      } finally {
        if (generation === refreshGeneration.current) setLoading(false);
      }
    },
    [base, readStatus, onStatusRead, onStatus, onRefreshStart],
  );

  useEffect(() => {
    setStatus(null);
    onReset();
    if (open) void refresh();
    return () => {
      refreshGeneration.current += 1;
    };
  }, [sessionId, open, refresh, onReset]);

  async function checkDetails(seat: DirectorSeat) {
    if (
      status?.statusMode !== 'durable' ||
      !seat.creationDiagnostic ||
      detailChecks[seat.seatId]?.pending
    )
      return;
    const epoch = refreshGeneration.current;
    const revision = status.config?.revision;
    const generation = seat.membership?.generation;
    setDetailChecks((old) => ({ ...old, [seat.seatId]: { pending: true } }));
    onDetailStart(seat.seatId);
    try {
      const checked = await readStatus(base);
      if (epoch !== refreshGeneration.current) return;
      const exact = checked.seats.find((item) => item.seatId === seat.seatId);
      if (
        checked.sessionId !== sessionId ||
        checked.statusMode === 'durable' ||
        checked.runtimeVerification === 'not_checked' ||
        !exact ||
        checked.config?.revision !== revision ||
        exact?.membership?.generation !== generation
      )
        throw new Error('Agent details changed. Refresh the agent list before continuing.');
      if (!checked.runtimeAvailable || !exact.creationDiagnostic)
        throw new Error('Current creation proof is unavailable. The saved failure is retained.');
      setStatus(
        (current) =>
          current && {
            ...current,
            seats: current.seats.map((item) =>
              item.seatId === seat.seatId
                ? { ...item, creationDiagnostic: exact.creationDiagnostic }
                : item,
            ),
          },
      );
      setDetailChecks((old) => ({ ...old, [seat.seatId]: { pending: false } }));
    } catch (cause) {
      if (epoch !== refreshGeneration.current) return;
      setDetailChecks((old) => ({
        ...old,
        [seat.seatId]: {
          pending: false,
          error: cause instanceof Error ? cause.message : 'Could not check connection details',
        },
      }));
    }
  }

  return { status, setStatus, detailChecks, loading, error, setError, refresh, checkDetails };
}
