import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionOutputCandidate, SessionOutputReference } from '@mitzo/protocol';
import type {
  AddOutputContributor,
  OutputContributor,
  OutputContributorPanelProps,
} from '../components/OutputContributorPanel';
import { apiFetch } from '../lib/api-fetch';
import { createBrowserId, sha256Hex } from '../lib/browser-crypto';

type View = Pick<
  OutputContributorPanelProps,
  | 'sessionId'
  | 'outputs'
  | 'candidates'
  | 'selected'
  | 'contributors'
  | 'eligibility'
  | 'loading'
  | 'error'
> & { unsupported?: boolean };
const unavailable = {
  available: null,
  reason: 'Contributor access has not been verified.',
  accountIds: [],
};
function initial(sessionId: string): View {
  return {
    sessionId,
    outputs: [],
    candidates: [],
    selected: null,
    contributors: [],
    eligibility: unavailable,
    loading: true,
  };
}
function validOutput(value: unknown, sessionId: string): value is SessionOutputReference {
  const output = value as SessionOutputReference | undefined;
  return (
    !!output &&
    output.sessionId === sessionId &&
    typeof output.outputId === 'string' &&
    typeof output.title === 'string' &&
    output.revision === 1 &&
    output.durability === 'reference_registered' &&
    output.label === 'In conversation' &&
    output.source?.sessionId === sessionId &&
    typeof output.source.messageId === 'string' &&
    typeof output.source.blockId === 'string' &&
    Number.isInteger(output.source.messageEndSeq) &&
    /^[a-f0-9]{64}$/.test(output.source.sha256)
  );
}
function validCandidate(value: unknown): value is SessionOutputCandidate {
  const candidate = value as SessionOutputCandidate | undefined;
  return (
    !!candidate &&
    typeof candidate.content === 'string' &&
    typeof candidate.source?.messageId === 'string' &&
    typeof candidate.source.blockId === 'string' &&
    Number.isInteger(candidate.source.messageEndSeq) &&
    /^[a-f0-9]{64}$/.test(candidate.source.sha256)
  );
}
async function read(url: string, signal?: AbortSignal) {
  const response = await apiFetch(url, { signal });
  const body = await response.json();
  if (!response.ok) throw Error(body?.error || `Request failed (${response.status})`);
  return body;
}
function stablePayload(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stablePayload).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stablePayload(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
/** Store only opaque fingerprints and retry IDs; never store draft/guidance bytes in browser storage. */
async function requestIdentity(
  sessionId: string,
  operation: string,
  payload: unknown,
): Promise<{ id: string; key: string }> {
  const fingerprint = sha256Hex(stablePayload(payload));
  const key = `mitzo-output-request:${encodeURIComponent(sessionId)}:${operation}:${fingerprint}`;
  const existing = sessionStorage.getItem(key);
  if (existing) return { id: existing, key };
  const id = createBrowserId();
  sessionStorage.setItem(key, id);
  if (sessionStorage.getItem(key) !== id)
    throw Error('Could not retain this request identity. Retry before starting work.');
  return { id, key };
}

/** Ordinary chat remains empty until explicit output registration; all authority comes from host reads. */
export function useOutputContributors(
  sessionId: string | null,
  enabled = true,
  refreshKey: string | number = '',
): OutputContributorPanelProps | null {
  const scope = enabled ? sessionId : null;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const [view, setView] = useState<View | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [selection, setSelection] = useState<{ sessionId: string; outputId: string } | null>(null);
  const selectedId = selection?.sessionId === scope ? selection.outputId : null;
  const refresh = useCallback(() => setAttempt((value) => value + 1), []);
  const selectionRef = useRef(selectedId);
  selectionRef.current = selectedId;
  useEffect(() => {
    if (!scope) return;
    const controller = new AbortController();
    let live = true;
    setView((previous) => ({
      ...(previous?.sessionId === scope ? previous : initial(scope)),
      loading: true,
      error: undefined,
      eligibility: previous?.sessionId === scope ? previous.eligibility : unavailable,
    }));
    const base = `/api/sessions/${encodeURIComponent(scope)}`;
    void (async () => {
      try {
        const result = await read(`${base}/outputs`, controller.signal);
        if (
          !Array.isArray(result.outputs) ||
          !Array.isArray(result.candidates) ||
          !result.outputs.every((entry: unknown) => validOutput(entry, scope)) ||
          !result.candidates.every(validCandidate)
        )
          throw Error('Output references are incomplete. Retry before continuing.');
        const outputs = result.outputs as SessionOutputReference[];
        const candidates = result.candidates as SessionOutputCandidate[];
        const chosen = outputs.find((output) => output.outputId === selectedId) ?? outputs[0];
        if (!chosen) {
          if (live && scopeRef.current === scope)
            setView({ ...initial(scope), outputs, candidates, loading: false });
          return;
        }
        const [access, body] = await Promise.allSettled([
          read(`${base}/contributors`, controller.signal),
          read(`${base}/outputs/${encodeURIComponent(chosen.outputId)}`, controller.signal),
        ]);
        if (!live || scopeRef.current !== scope || selectionRef.current !== selectedId) return;
        let error: string | undefined;
        let eligibility = unavailable as OutputContributorPanelProps['eligibility'];
        let contributors: OutputContributor[] | undefined;
        if (access.status === 'fulfilled') {
          const data = access.value;
          if (
            !Array.isArray(data.contributors) ||
            !data.eligibility ||
            ![true, false, null].includes(data.eligibility.available) ||
            typeof data.eligibility.reason !== 'string' ||
            !Array.isArray(data.eligibility.accountIds) ||
            !data.eligibility.accountIds.every((id: unknown) => typeof id === 'string')
          )
            throw Error('Contributor access is incomplete. Retry before continuing.');
          contributors = data.contributors;
          eligibility = data.eligibility;
        } else
          error =
            access.reason instanceof Error
              ? access.reason.message
              : 'Contributor access could not be verified.';
        let selected: OutputContributorPanelProps['selected'] = {
          output: chosen,
          content: null,
          contextPackageDigest: null,
        };
        if (body.status === 'fulfilled') {
          const data = body.value;
          if (
            !validOutput(data.output, scope) ||
            data.output.outputId !== chosen.outputId ||
            data.output.revision !== chosen.revision ||
            typeof data.content !== 'string' ||
            !/^[a-f0-9]{64}$/.test(data.contextPackageDigest)
          )
            throw Error('The selected draft revision could not be verified.');
          selected = {
            output: data.output,
            content: data.content,
            contextPackageDigest: data.contextPackageDigest,
          };
        } else
          error ??=
            body.reason instanceof Error
              ? body.reason.message
              : 'The selected draft is unavailable.';
        setView((previous) => ({
          sessionId: scope,
          outputs,
          candidates,
          selected,
          contributors:
            contributors ?? (previous?.sessionId === scope ? previous.contributors : []),
          eligibility,
          loading: false,
          error,
        }));
      } catch (cause) {
        if (live && scopeRef.current === scope)
          setView((previous) => ({
            ...(previous?.sessionId === scope ? previous : initial(scope)),
            eligibility: unavailable,
            loading: false,
            error: cause instanceof Error ? cause.message : 'Outputs could not be loaded.',
          }));
      }
    })();
    return () => {
      live = false;
      controller.abort();
    };
  }, [scope, attempt, refreshKey, selectedId]);
  const current = view?.sessionId === scope ? view : null;
  const hasOutputs = !!current?.outputs.length;
  useEffect(() => {
    if (!scope || !hasOutputs) return;
    const timer = window.setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [scope, hasOutputs, refresh]);
  const mutate = useCallback(
    async (
      operation: string,
      endpoint: string,
      payload: Record<string, unknown>,
      receipt: (body: unknown) => boolean,
    ) => {
      if (!scope || scopeRef.current !== scope) throw Error('The source conversation has changed.');
      const identity = await requestIdentity(scope, operation, payload);
      if (scopeRef.current !== scope)
        throw Error('The source conversation changed before this request started.');
      const response = await apiFetch(`/api/sessions/${encodeURIComponent(scope)}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, requestId: identity.id }),
      });
      const body = await response.json();
      if (!response.ok)
        throw Error(body?.error || `Request could not be confirmed (${response.status}).`);
      if (!receipt(body))
        throw Error(
          'The response did not confirm this request. Retry to reconcile the same operation.',
        );
      // Only an exact host receipt ends this command. A later intentional
      // identical message/Stop is a new command; uncertainty keeps the old ID.
      sessionStorage.removeItem(identity.key);
      if (scopeRef.current === scope) refresh();
      return body;
    },
    [scope, refresh],
  );
  const register = useCallback(
    async (candidate: SessionOutputCandidate, title: string) => {
      await mutate('register', 'outputs', { title, source: candidate.source }, (body) => {
        const output = (body as { output?: unknown })?.output;
        return (
          !!scope &&
          validOutput(output, scope) &&
          output.title === title &&
          stablePayload(output.source) === stablePayload({ sessionId: scope, ...candidate.source })
        );
      });
    },
    [mutate, scope],
  );
  const add = useCallback(
    async (input: AddOutputContributor) => {
      if (
        !current?.selected ||
        current.selected.output.outputId !== input.outputId ||
        current.selected.output.revision !== input.outputRevision ||
        current.selected.contextPackageDigest !== input.contextPackageDigest ||
        current.eligibility.available !== true ||
        !current.eligibility.accountIds?.includes(input.accountId)
      )
        throw Error(
          'The selected draft or account access has changed. Refresh access before continuing.',
        );
      await mutate('add', 'contributors', input as unknown as Record<string, unknown>, (body) => {
        const contributor = (body as { contributor?: OutputContributor })?.contributor;
        return (
          !!contributor &&
          typeof contributor.id === 'string' &&
          contributor.outputId === input.outputId &&
          contributor.outputRevision === input.outputRevision &&
          contributor.label === input.label &&
          contributor.model === input.model
        );
      });
    },
    [current, mutate],
  );
  const send = useCallback(
    async (id: string, text: string) => {
      const contributor = current?.contributors.find((entry) => entry.id === id);
      if (
        !contributor ||
        current?.eligibility.available !== true ||
        contributor.status === 'unavailable' ||
        contributor.status === 'running' ||
        contributor.status === 'stopping' ||
        current.selected?.output.outputId !== contributor.outputId ||
        current.selected.output.revision !== contributor.outputRevision
      )
        throw Error('This contributor is unavailable for the selected draft.');
      const body = await mutate(
        `send:${id}`,
        `contributors/${encodeURIComponent(id)}/messages`,
        { text },
        (body) => {
          const value = body as {
            delivery?: { deliveryId?: string };
            contributor?: OutputContributor;
          };
          return typeof value?.delivery?.deliveryId === 'string' && value.contributor?.id === id;
        },
      );
      // This receipt ends the command even when execution failed. Preserve the
      // compose draft through rejection; a deliberate retry gets a fresh ID.
      if (body.delivery.status === 'failed')
        throw Error(
          'Contributor execution failed. Your draft is preserved. Check its conversation and current account before retrying.',
        );
    },
    [current, mutate],
  );
  const stop = useCallback(
    async (id: string) => {
      if (!current?.contributors.some((entry) => entry.id === id))
        throw Error('This contributor is no longer in the source conversation.');
      await mutate(`stop:${id}`, `contributors/${encodeURIComponent(id)}/stop`, {}, (body) => {
        const contributor = (body as { contributor?: OutputContributor })?.contributor;
        return (
          contributor?.id === id &&
          (contributor.status === 'idle' ||
            contributor.status === 'stopping' ||
            contributor.status === 'unavailable')
        );
      });
    },
    [current, mutate],
  );
  if (!scope) return null;
  const props = current ?? initial(scope);
  return {
    ...props,
    onRegister: register,
    onSelect: (outputId) => setSelection({ sessionId: scope, outputId }),
    onAdd: add,
    onSend: send,
    onStop: stop,
    onRefresh: refresh,
  };
}
