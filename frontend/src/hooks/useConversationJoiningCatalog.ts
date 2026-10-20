import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MitzoApiClient } from '@mitzo/client';
import {
  CollaborationSourceCatalogRequestSchema,
  CollaborationRetainedArtifactPinSchema,
  type CollaborationSourceCatalog,
  type CollaborationArtifactPin,
} from '@mitzo/protocol';
import {
  apiFetch,
  AUTH_LOST_EVENT,
  AUTH_RESTORED_EVENT,
  currentVerifiedAuthSessionId,
  getApiBaseUrl,
} from '../lib/api-fetch';
import {
  conversationArtifactKey,
  conversationArtifactPin,
} from '../lib/conversation-joining-artifacts';
import { joiningReviewEqual as equal } from '../lib/conversation-joining-recovery';

const api = new MitzoApiClient(apiFetch);
type Artifact = CollaborationSourceCatalog['artifacts'][number];
type History = { seed: Artifact; cursor: number | null; hasMore: boolean };
type Data = {
  catalog: CollaborationSourceCatalog;
  artifacts: Artifact[];
  histories: Record<string, History>;
};
function mergeArtifacts(existing: Artifact[], incoming: Artifact[]) {
  const versionKey = (artifact: Artifact) =>
    JSON.stringify([
      'kind' in artifact ? artifact.kind : 'inline',
      artifact.artifactId,
      artifact.revision,
    ]);
  const versions = new Map(existing.map((artifact) => [versionKey(artifact), artifact.sha256]));
  const result = new Map(existing.map((artifact) => [conversationArtifactKey(artifact), artifact]));
  for (const artifact of incoming) {
    const version = versionKey(artifact);
    if (versions.has(version) && versions.get(version) !== artifact.sha256)
      throw Error('Saved version hash changed');
    const key = conversationArtifactKey(artifact);
    const previous = result.get(key);
    if (previous && !equal(previous, artifact)) throw Error('Saved version metadata changed');
    result.set(key, artifact);
    versions.set(version, artifact.sha256);
  }
  return [...result.values()];
}
const historyKey = (artifact: CollaborationArtifactPin) =>
  JSON.stringify(['retainedArtifactVersion', artifact.artifactId]);

/** Current, private metadata only. POST catalog/history reads never create a
 * relationship, target, session, capacity receipt or model response. */
export function useConversationJoiningCatalog(options: {
  sourceConversationId: string | null;
  clientId: string | null | undefined;
}) {
  const { sourceConversationId, clientId } = options;
  const [login, setLogin] = useState(currentVerifiedAuthSessionId);
  const [loginEpoch, setLoginEpoch] = useState(0);
  const epoch = useRef(0);
  const base = getApiBaseUrl();
  const scope = useMemo(
    () => ({ sourceConversationId, clientId, login, base, loginEpoch }),
    [sourceConversationId, clientId, login, base, loginEpoch],
  );
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [attempt, setAttempt] = useState(0);
  const attemptRef = useRef(0);
  const operation = useRef(0);
  const active = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const [result, setResult] = useState<{
    scope: typeof scope;
    attempt: number;
    data: Data | null;
    pending: boolean;
    error?: string;
  }>();
  const latest = useRef(result);
  latest.current = result;
  const valid =
    !!login &&
    CollaborationSourceCatalogRequestSchema.safeParse({ sourceConversationId, clientId }).success;
  useEffect(() => {
    alive.current = true;
    const invalidate = () => {
      operation.current++;
      active.current?.abort();
      setLoginEpoch(++epoch.current);
      setLogin(undefined);
      setResult(undefined);
      queueMicrotask(() => {
        if (alive.current) setLogin(currentVerifiedAuthSessionId());
      });
    };
    window.addEventListener(AUTH_LOST_EVENT, invalidate);
    window.addEventListener(AUTH_RESTORED_EVENT, invalidate);
    return () => {
      alive.current = false;
      operation.current++;
      active.current?.abort();
      window.removeEventListener(AUTH_LOST_EVENT, invalidate);
      window.removeEventListener(AUTH_RESTORED_EVENT, invalidate);
    };
  }, []);
  const isCurrent = useCallback(
    (owner: typeof scope, sequence: number, signal: AbortSignal, expectedAttempt: number) =>
      alive.current &&
      !signal.aborted &&
      currentScope.current === owner &&
      operation.current === sequence &&
      epoch.current === owner.loginEpoch &&
      attemptRef.current === expectedAttempt &&
      currentVerifiedAuthSessionId() === owner.login &&
      getApiBaseUrl() === owner.base,
    [],
  );
  useEffect(() => {
    const query = CollaborationSourceCatalogRequestSchema.safeParse({
      sourceConversationId: scope.sourceConversationId,
      clientId: scope.clientId,
    });
    if (!valid || !query.success) return;
    const controller = new AbortController();
    active.current?.abort();
    active.current = controller;
    const sequence = ++operation.current;
    void (async () => {
      try {
        if (!isCurrent(scope, sequence, controller.signal, attempt)) return;
        const catalog = await api.collaborations.sourceCatalog(query.data, controller.signal);
        if (!isCurrent(scope, sequence, controller.signal, attempt)) return;
        setResult({
          scope,
          attempt,
          data: { catalog, artifacts: mergeArtifacts([], catalog.artifacts), histories: {} },
          pending: false,
        });
      } catch {
        if (isCurrent(scope, sequence, controller.signal, attempt))
          setResult({
            scope,
            attempt,
            data: null,
            pending: false,
            error: 'Saved context could not be checked. Your selections stay here.',
          });
      }
    })();
    return () => {
      controller.abort();
    };
  }, [scope, attempt, valid, isCurrent]);
  const visible =
    valid &&
    currentVerifiedAuthSessionId() === login &&
    getApiBaseUrl() === base &&
    epoch.current === scope.loginEpoch &&
    result?.scope === scope &&
    result.attempt === attempt
      ? result
      : undefined;
  const data = visible?.data ?? null;
  const loading = valid && !visible;
  const pending = loading || !!visible?.pending;
  const readPage = async (artifact?: CollaborationArtifactPin) => {
    const held = latest.current;
    if (
      !valid ||
      !held?.data ||
      held.scope !== scope ||
      held.attempt !== attempt ||
      attemptRef.current !== attempt ||
      currentScope.current !== scope ||
      epoch.current !== scope.loginEpoch ||
      held.pending
    )
      return;
    const original = held.data;
    if (artifact && !('kind' in artifact)) return;
    const history = artifact ? original.histories[historyKey(artifact)] : undefined;
    if (artifact ? history?.hasMore === false : !original.catalog.artifactHasMore) return;
    const controller = new AbortController();
    active.current?.abort();
    active.current = controller;
    const sequence = ++operation.current;
    const waiting = { ...held, pending: true, error: undefined };
    latest.current = waiting;
    setResult(waiting);
    try {
      if (!isCurrent(scope, sequence, controller.signal, attempt)) return;
      let next: Data;
      if (artifact && 'kind' in artifact) {
        const seed =
          history?.seed ??
          original.artifacts.find(
            (entry) => conversationArtifactKey(entry) === conversationArtifactKey(artifact),
          );
        if (!seed || !('kind' in seed)) throw Error('Saved version unavailable');
        const page = await api.collaborations.sourceArtifactVersions(
          {
            sourceConversationId: sourceConversationId!,
            clientId: clientId!,
            boundary: original.catalog.boundary,
            artifact: CollaborationRetainedArtifactPinSchema.parse(conversationArtifactPin(seed)),
            ...(history?.cursor ? { beforeRevision: history.cursor } : {}),
            limit: 50,
          },
          controller.signal,
        );
        if (page.hasMore && history && page.cursor === history.cursor)
          throw Error('Saved version history cursor changed');
        next = {
          ...original,
          artifacts: mergeArtifacts(original.artifacts, page.artifacts),
          histories: {
            ...original.histories,
            [historyKey(artifact)]: { seed, cursor: page.cursor, hasMore: page.hasMore },
          },
        };
      } else {
        const page = await api.collaborations.sourceCatalog(
          {
            sourceConversationId: sourceConversationId!,
            clientId: clientId!,
            artifactsAfter: original.catalog.artifactCursor!,
          },
          controller.signal,
        );
        if (
          !equal(page.boundary, original.catalog.boundary) ||
          !equal(page.messages, original.catalog.messages) ||
          !equal(page.sourceRepository, original.catalog.sourceRepository) ||
          page.retainedAvailability !== original.catalog.retainedAvailability ||
          (page.artifactHasMore && equal(page.artifactCursor, original.catalog.artifactCursor))
        )
          throw Error('Saved context changed during pagination');
        next = {
          ...original,
          catalog: page,
          artifacts: mergeArtifacts(original.artifacts, page.artifacts),
        };
      }
      if (isCurrent(scope, sequence, controller.signal, attempt))
        setResult({ ...held, data: next, pending: false, error: undefined });
    } catch {
      if (isCurrent(scope, sequence, controller.signal, attempt))
        setResult({
          ...held,
          pending: false,
          error: 'More saved context could not be checked. Your selections stay here.',
        });
    }
  };
  const refresh = useCallback(() => {
    operation.current++;
    active.current?.abort();
    setAttempt(++attemptRef.current);
  }, []);
  return {
    scope,
    catalog: data?.catalog ?? null,
    messages: data?.catalog.messages ?? [],
    artifacts: data?.artifacts ?? [],
    loading,
    pending,
    reason: !valid
      ? 'Reconnect to check saved context.'
      : loading
        ? 'Checking saved context…'
        : visible?.error,
    refresh,
    hasMore: data?.catalog.artifactHasMore ?? false,
    loadMore: () => readPage(),
    loadEarlier: (artifact: CollaborationArtifactPin) => readPage(artifact),
    hasEarlier: (artifact: CollaborationArtifactPin) =>
      data?.histories[historyKey(artifact)]?.hasMore ?? true,
  };
}
