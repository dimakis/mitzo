import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { apiFetch } from '../lib/api-fetch';
import {
  repositoryChatPreparationResultSchema,
  type RepositoryChatPreparation,
} from '../lib/repository-chat-preparation';

/** A route receipt recovers the server draft; it never starts or repeats preparation. */
export function useRepositoryChatPreparation(id: string | null, sessionId?: string) {
  const route = JSON.stringify([id, sessionId ?? null]);
  const fence = useRef({ route, revision: 0 });
  if (fence.current.route !== route)
    fence.current = { route, revision: fence.current.revision + 1 };
  const scope = `${fence.current.revision}:${route}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [attempt, setAttempt] = useState(0);
  const currentAttempt = useRef(attempt);
  currentAttempt.current = attempt;
  const [result, setResult] = useState<{
    scope: string;
    attempt: number;
    preparation?: RepositoryChatPreparation;
    error?: string;
  }>();
  const [assigned, setAssigned] = useState<{ scope: string; conversationId: string }>();
  const present = id !== null;
  const validId = z.uuid().safeParse(id).success;
  useEffect(() => {
    if (!present || !validId || sessionId) return;
    const controller = new AbortController();
    void Promise.resolve()
      .then(() =>
        apiFetch(`/api/repository-workspaces/${id}/chat-preparation`, {
          signal: controller.signal,
        }),
      )
      .then(async (response) => {
        if (!response.ok)
          throw new Error('Repository preparation unavailable. Refresh its status to retry.');
        const data = repositoryChatPreparationResultSchema.parse(await response.json());
        if (data.repositoryChat.id !== id)
          throw new Error('Repository preparation identity changed');
        if (!controller.signal.aborted && currentScope.current === scope)
          setResult({ scope, attempt, preparation: data.repositoryChat });
      })
      .catch(() => {
        if (!controller.signal.aborted && currentScope.current === scope)
          setResult({
            scope,
            attempt,
            error: 'Repository preparation unavailable. Refresh its status to retry.',
          });
      });
    return () => controller.abort();
  }, [id, present, validId, sessionId, scope, attempt]);
  const preparation = result?.scope === scope ? result.preparation : undefined;
  const loading =
    present && validId && !sessionId && (result?.scope !== scope || result.attempt !== attempt);
  const reason = !present
    ? undefined
    : sessionId
      ? 'Open this repository preparation in a new chat.'
      : !validId
        ? 'Invalid repository preparation link.'
        : loading
          ? 'Loading repository preparation…'
          : (result?.error ??
            (preparation?.state === 'ready'
              ? undefined
              : preparation?.state === 'claimed'
                ? 'This preparation already belongs to a conversation.'
                : `Repository preparation is ${preparation?.state ?? 'unavailable'}. Refresh its status before sending.`));
  return {
    present,
    id,
    scope,
    preparation,
    loading,
    reason,
    retry: () => setAttempt((value) => value + 1),
    assignedConversationId: assigned?.scope === scope ? assigned.conversationId : null,
    markAssigned: (conversationId: string) => {
      if (
        currentScope.current === scope &&
        currentAttempt.current === attempt &&
        preparation?.state === 'ready' &&
        !reason
      )
        setAssigned({ scope, conversationId });
    },
  };
}

export function repositoryChatSendDisabledReason(
  handoff: ReturnType<typeof useRepositoryChatPreparation>,
  activeSessionId: string | null,
  selection: { accountId?: string; model: string } | null,
  repository: { blocked: boolean; repositoryWorkspaceId?: string } | null,
): string | undefined {
  if (!handoff.present) return undefined;
  if (handoff.reason) return handoff.reason;
  if (activeSessionId) return 'Opening the new repository draft…';
  const preparation = handoff.preparation;
  if (
    !preparation ||
    selection?.accountId !== preparation.accountId ||
    selection.model !== preparation.model
  )
    return 'The prepared account and model must be available before sending.';
  if (repository?.blocked || repository?.repositoryWorkspaceId !== preparation.id)
    return 'Verify the original repository preparation before sending.';
  return undefined;
}
