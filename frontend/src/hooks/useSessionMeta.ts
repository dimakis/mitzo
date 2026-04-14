import { useEffect } from 'react';
import type { TokenAction } from './useTokenState.js';

interface SessionMetaResponse {
  sessionId: string;
  branch: string | null;
  wtId: string | null;
  cwd: string | null;
  mode: string;
  isActive: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCostUsd: number;
  numTurns: number;
}

type MessageDispatch = (action: {
  type: 'SESSION_INFO';
  branch: string;
  isWorktree: boolean;
  wtId?: string;
}) => void;

/**
 * Hydrates branch/worktree and token state from persisted session metadata.
 * Runs on mount when sessionId is defined, providing immediate context strip
 * data without waiting for live WebSocket messages.
 */
export function useSessionMeta(
  sessionId: string | undefined,
  dispatch: MessageDispatch,
  tokenDispatch: React.Dispatch<TokenAction>,
): void {
  useEffect(() => {
    if (!sessionId) return;

    const controller = new AbortController();

    fetch(`/api/sessions/${sessionId}/meta`, {
      credentials: 'include',
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((meta: SessionMetaResponse | null) => {
        if (controller.signal.aborted || !meta) return;

        if (meta.branch) {
          dispatch({
            type: 'SESSION_INFO',
            branch: meta.branch,
            isWorktree: !!meta.wtId,
            wtId: meta.wtId ?? undefined,
          });
        }

        if (meta.numTurns > 0) {
          tokenDispatch({
            type: 'TOKEN_UPDATE',
            agentContext: 0,
            sessionTotal:
              meta.inputTokens +
              meta.outputTokens +
              meta.cacheReadTokens +
              meta.cacheCreationTokens,
            numTurns: meta.numTurns,
            turnIndex: meta.numTurns,
          });
        }
      })
      .catch(() => {});

    return () => controller.abort();
  }, [sessionId, dispatch, tokenDispatch]);
}
