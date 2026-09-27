import { useEffect, useState, useRef } from 'react';
import { z } from 'zod';
import { apiFetch } from '../lib/api-fetch';
const candidate = z.object({
  operationId: z.string(),
  grantId: z.string(),
  bindingHash: z.string(),
  sessionId: z.string(),
  connectionId: z.string(),
  connectionRevision: z.number().int().positive(),
  credentialGeneration: z.string(),
  repository: z.string(),
  recordId: z.string(),
  recordHash: z.string(),
  sealHash: z.string(),
  sealId: z.string(),
  principal: z.object({ host: z.literal('github.com'), numericId: z.number(), login: z.string() }),
});
type Candidate = z.infer<typeof candidate>;
export function SymposiumPublicationRecovery({
  sessionId,
  record,
  onUncertain,
  onRecovered,
}: {
  sessionId: string;
  record: { id: string; hash: string } | null;
  onUncertain(value: boolean): void;
  onRecovered(): void;
}) {
  const base = `/api/sessions/${encodeURIComponent(sessionId)}/symposium/publication`;
  const [operations, setOperations] = useState<Candidate[]>([]),
    [selected, setSelected] = useState(''),
    [passphrase, setPassphrase] = useState(''),
    [status, setStatus] = useState(''),
    [busy, setBusy] = useState(false),
    [refresh, setRefresh] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const recordId = record?.id,
    recordHash = record?.hash;
  useEffect(() => {
    setOperations([]);
    setBusy(false);
    setSelected('');
    setPassphrase('');
    if (!recordId || !recordHash) {
      onUncertain(true);
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    onUncertain(true);
    void apiFetch(base + '/recovery?' + new URLSearchParams({ recordId, recordHash }), {
      signal: abort.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw Error('Recovery unavailable');
        const data = await response.json();
        const values = z.array(candidate).max(100).parse(data.operations);
        if (
          values.some(
            (value) =>
              value.sessionId !== sessionId ||
              value.recordId !== recordId ||
              value.recordHash !== recordHash,
          )
        )
          throw Error('Session changed');
        if (!abort.signal.aborted) {
          setOperations(values);
          setSelected('');
          onUncertain(values.length > 0);
        }
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setStatus('Pending publication status is unavailable. Do not retry a write.');
      });
    return () => abort.abort();
  }, [base, sessionId, recordId, recordHash, refresh, onUncertain]);
  const current = operations.find((value) => value.operationId === selected);
  async function post(path: string, body: unknown, signal: AbortSignal, csrf?: string) {
    const response = await apiFetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
      body: JSON.stringify(body),
      signal,
    });
    const data = await response.json();
    signal.throwIfAborted();
    if (!response.ok)
      throw Error('Read-only recovery unavailable; the original operation remains unchanged.');
    return data;
  }
  async function recover() {
    const signal = controller.current?.signal;
    if (
      !current ||
      !signal ||
      signal.aborted ||
      current.recordId !== recordId ||
      current.recordHash !== recordHash
    )
      return;
    const secret = passphrase;
    setPassphrase('');
    setBusy(true);
    setStatus('');
    try {
      const auth = await post('/recovery/reauthorize', { passphrase: secret }, signal);
      if (
        typeof auth.csrf !== 'string' ||
        !Number.isFinite(auth.expiresAt) ||
        auth.expiresAt <= Date.now()
      )
        throw Error('Recent authorization expired.');
      const result = await post(
        '/recovery',
        {
          recordId: current.recordId,
          recordHash: current.recordHash,
          sealId: current.sealId,
          sealHash: current.sealHash,
          repository: current.repository,
          operationId: current.operationId,
          grantId: current.grantId,
          bindingHash: current.bindingHash,
          connectionId: current.connectionId,
          connectionRevision: current.connectionRevision,
          credentialGeneration: current.credentialGeneration,
        },
        signal,
        auth.csrf,
      );
      if (result.id !== current.operationId) throw Error('Recovery operation changed.');
      setStatus(
        result.status === 'succeeded'
          ? 'Original publication verified. No write was repeated.'
          : 'Publication remains unverified. No write was repeated.',
      );
      if (result.status === 'succeeded') {
        onRecovered();
        setRefresh((value) => value + 1);
      }
    } catch (error) {
      if (!signal.aborted)
        setStatus(error instanceof Error ? error.message : 'Recovery unavailable');
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  return (
    <section aria-label="Read-only publication recovery">
      <h4>Verify an uncertain publication</h4>
      <p>
        This only checks the original operation. It cannot create or update a pull request, export
        an artifact, or replace an approval.
      </p>
      <button disabled={busy} onClick={() => setRefresh((value) => value + 1)}>
        Refresh uncertain publications
      </button>
      {operations.length > 0 && (
        <fieldset disabled={busy}>
          <label>
            Uncertain publication
            <select
              value={selected}
              onChange={(event) => {
                setSelected(event.target.value);
                setPassphrase('');
              }}
            >
              <option value="">Select the exact operation</option>
              {operations.map((value) => (
                <option key={value.operationId} value={value.operationId}>
                  {value.operationId} — {value.repository}
                </option>
              ))}
            </select>
          </label>
          {current && (
            <>
              <p>
                {current.principal.login} ({current.principal.numericId}) · credential{' '}
                {current.connectionId} revision {current.connectionRevision} · review{' '}
                {current.recordId} · seal {current.sealId}
              </p>
              <label>
                App passphrase for read-only recovery
                <input
                  type="password"
                  autoComplete="current-password"
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                />
              </label>
              <button disabled={!passphrase} onClick={() => void recover()}>
                Verify selected operation — no writes
              </button>
            </>
          )}
        </fieldset>
      )}
      {status && <p role="status">{status}</p>}
    </section>
  );
}
