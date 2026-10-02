import { SymposiumPublicationRecovery } from './SymposiumPublicationRecovery';
import { useMitzoStore } from '@mitzo/client/hooks';
import { z } from 'zod';
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/api-fetch';
import type {
  PublicationCredential,
  PublicationSelection,
  PublicationPrincipal,
  PublicationGrant,
} from '../types/symposium-publication';
const pendingSchema = z.strictObject({
  grantId: z.string(),
  bindingHash: z.string(),
  turnId: z.string(),
  idempotencyKey: z.string(),
  baseBranch: z.string(),
  title: z.string(),
  body: z.string(),
  draft: z.boolean(),
});
function pendingRequest(key: string) {
  try {
    return pendingSchema.parse(JSON.parse(sessionStorage.getItem(key) ?? 'null'));
  } catch {
    return null;
  }
}
export function SymposiumPublication(props: {
  sessionId: string;
  record: { id: string; hash: string } | null;
}) {
  return <Publication key={`${props.sessionId}:${props.record?.id ?? ''}`} {...props} />;
}
function Publication({
  sessionId,
  record,
}: {
  sessionId: string;
  record: { id: string; hash: string } | null;
}) {
  const getTransportConnectionId = useMitzoStore((state) => state.getTransportConnectionId);
  const base = `/api/sessions/${encodeURIComponent(sessionId)}/symposium/publication`;
  const storageKey = `mitzo-publication:${sessionId}:${record?.id ?? ''}`;
  const [saved] = useState(() => pendingRequest(storageKey));
  const [credentials, setCredentials] = useState<PublicationCredential[]>([]);
  const [available, setAvailable] = useState(false);
  const [credential, setCredential] = useState('');
  const [repository, setRepository] = useState('');
  const [selection, setSelection] = useState<PublicationSelection | null>(null);
  const [principal, setPrincipal] = useState<PublicationPrincipal | null>(null);
  const [grant, setGrant] = useState<PublicationGrant | null>(
    saved ? { id: saved.grantId, bindingHash: saved.bindingHash } : null,
  );
  const [title, setTitle] = useState(saved?.title ?? '');
  const [body, setBody] = useState('');
  const [branch, setBranch] = useState(saved?.baseBranch ?? 'main');
  const [draft, setDraft] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [url, setUrl] = useState('');
  const [pending, setPending] = useState(Boolean(saved));
  const [retainedPending, setRetainedPending] = useState(true);
  const operation = useRef<z.infer<typeof pendingSchema> | null>(saved);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    void apiFetch(base, { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Publication registration unavailable');
        const data = await response.json();
        if (!abort.signal.aborted) {
          setAvailable(data.available === true);
          setCredentials(data.credentials ?? []);
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) setStatus('Publication registration unavailable');
      });
    return () => abort.abort();
  }, [base]);
  async function post(path: string, input: unknown) {
    const connectionId = path === 'publish' ? getTransportConnectionId() : null;
    if (path === 'publish' && !connectionId)
      throw new Error('Connect this tab to the session before publishing');
    const response = await apiFetch(`${base}/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(connectionId ? { 'X-Connection-ID': connectionId } : {}),
      },
      body: JSON.stringify(input),
      signal: controller.current?.signal,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Publication unavailable');
    return result;
  }
  async function action(run: () => Promise<void>) {
    setBusy(true);
    setStatus('');
    try {
      await run();
    } catch (error) {
      if (!controller.current?.signal.aborted)
        setStatus(error instanceof Error ? error.message : 'Publication unavailable');
    } finally {
      if (!controller.current?.signal.aborted) setBusy(false);
    }
  }
  function clearSelection() {
    setSelection(null);
    setPrincipal(null);
    setGrant(null);
    operation.current = null;
    sessionStorage.removeItem(storageKey);
    setUrl('');
  }
  return (
    <section aria-label="Publish reviewed artifact">
      <h3>Publish reviewed artifact</h3>
      {!record ? (
        <p>
          A trusted review record and completed artifact seal are required. Native review remains
          unavailable until supported hard budgets and final usage receipts are available.
        </p>
      ) : !available ? (
        <p>An operator publication credential must be registered for this workspace.</p>
      ) : (
        <>
          <fieldset disabled={busy || pending || retainedPending || Boolean(url)}>
            <label>
              Publication credential
              <select
                value={credential}
                onChange={(e) => {
                  setCredential(e.target.value);
                  clearSelection();
                }}
              >
                <option value="">Choose an account</option>
                {credentials.map((value) => (
                  <option key={value.id} value={value.id}>
                    {value.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Repository
              <input
                value={repository}
                placeholder="owner/repository"
                onChange={(e) => {
                  setRepository(e.target.value);
                  clearSelection();
                }}
              />
            </label>
            <button
              disabled={!credential || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)}
              onClick={() =>
                void action(async () => {
                  clearSelection();
                  const source = credentials.find((value) => value.id === credential)!;
                  const selected = await post('select', {
                    connectionId: source.id,
                    revision: source.revision,
                  });
                  const artifact = await post('artifact', { recordId: record.id });
                  if (artifact.recordHash !== record.hash) throw new Error('Review record changed');
                  const scope = {
                    connectionId: selected.connectionId,
                    connectionRevision: selected.connectionRevision,
                    credentialGeneration: selected.credentialGeneration,
                    recordId: artifact.recordId,
                    recordHash: artifact.recordHash,
                    sealId: artifact.sealId,
                    sealHash: artifact.sealHash,
                    repository,
                  };
                  const preview = await post('preview', scope);
                  setSelection(scope);
                  setPrincipal(preview.principal);
                })
              }
            >
              Preview selected account
            </button>
            {principal && selection && (
              <>
                <p>
                  GitHub account: {principal.login} (ID {principal.numericId})
                </p>
                <p>
                  Repository: {selection.repository}; review: {selection.recordId}; seal:{' '}
                  {selection.sealId}
                </p>
                <button
                  onClick={() =>
                    void action(async () => {
                      setGrant(await post('grant', { selection, principal }));
                    })
                  }
                >
                  Use this account and artifact
                </button>
              </>
            )}
            <label>
              PR title
              <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={256} />
            </label>
            <label>
              Base branch
              <input value={branch} onChange={(e) => setBranch(e.target.value)} />
            </label>
            <label>
              PR description
              <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={58000} />
            </label>
            <label>
              <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
              Draft PR
            </label>
          </fieldset>
          {grant && (
            <>
              <p>Mitzo will ask you to approve the complete operation before publishing.</p>
              <button
                disabled={
                  busy ||
                  pending ||
                  retainedPending ||
                  Boolean(url) ||
                  !title.trim() ||
                  !branch.trim()
                }
                onClick={() =>
                  void action(async () => {
                    if (!operation.current)
                      operation.current = {
                        grantId: grant.id,
                        bindingHash: grant.bindingHash,
                        turnId: crypto.randomUUID(),
                        idempotencyKey: crypto.randomUUID(),
                        baseBranch: branch,
                        title,
                        body: `${body}\n\nReview record: ${record.id}\nSHA256: ${record.hash}`,
                        draft,
                      };
                    sessionStorage.setItem(storageKey, JSON.stringify(operation.current));
                    setPending(true);
                    const result = await post('publish', operation.current);
                    setStatus(result.status);
                    if (['denied', 'failed', 'cancelled'].includes(result.status)) {
                      setPending(false);
                      clearSelection();
                    }
                    if (result.status === 'succeeded') sessionStorage.removeItem(storageKey);
                    if (
                      result.status === 'succeeded' &&
                      typeof result.externalResultId === 'string' &&
                      /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(
                        result.externalResultId,
                      )
                    )
                      setUrl(result.externalResultId);
                    // Retain the exact operation across uncertainty. Never silently retry a write with a new identity.
                  })
                }
              >
                {pending ? 'Publication outcome requires verification' : 'Create PR'}
              </button>
            </>
          )}
        </>
      )}
      <SymposiumPublicationRecovery
        sessionId={sessionId}
        record={record}
        onUncertain={setRetainedPending}
        onRecovered={() => {
          sessionStorage.removeItem(storageKey);
          setPending(false);
          clearSelection();
        }}
      />
      {status && <p role="status">{status}</p>}
      {url && <a href={url}>Open pull request</a>}
    </section>
  );
}
