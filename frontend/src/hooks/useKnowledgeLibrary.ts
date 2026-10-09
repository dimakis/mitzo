import { useEffect, useRef, useState } from 'react';
import { apiFetch, getApiBaseUrl } from '../lib/api-fetch';
import type {
  KnowledgeCatalog,
  KnowledgeDocument,
  KnowledgeDraft,
  KnowledgeDraftSummary,
} from '../types/knowledge';
interface DraftCreation {
  requestId: string;
  title: string;
  baseRevision: string;
  documents: { path: string; content: string }[];
}
interface WorkingCopy {
  title: string;
  baseRevision: string;
  draft?: KnowledgeDraft;
  pendingCreate?: DraftCreation;
  initialSaveConflict?: KnowledgeDraft;
  savedComparisonUnavailable?: boolean;
  forkNeedsComparison?: boolean;
  documents: KnowledgeDraft['documents'];
  selected: string;
  saved: string;
}
const storageKey = `mitzo-knowledge-working-copy:${getApiBaseUrl()}`;
function recover(): WorkingCopy | null {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || 'null');
    return value &&
      typeof value.title === 'string' &&
      typeof value.baseRevision === 'string' &&
      typeof value.selected === 'string' &&
      typeof value.saved === 'string' &&
      Array.isArray(value.documents) &&
      value.documents.every(
        (d: KnowledgeDraft['documents'][number]) =>
          typeof d.path === 'string' && typeof d.base === 'string' && typeof d.content === 'string',
      )
      ? value
      : null;
  } catch {
    return null;
  }
}
class KnowledgeApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await apiFetch(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok)
    throw new KnowledgeApiError(
      data.error || 'Knowledge could not be reached. Your changes are preserved.',
      response.status,
    );
  return data;
}
function needsReview(draft: KnowledgeDraft) {
  return draft.review?.version !== draft.version || Boolean(draft.error);
}
export function useKnowledgeLibrary() {
  const [catalog, setCatalog] = useState<KnowledgeCatalog | null>(null);
  const [copy, setCopy] = useState<WorkingCopy | null>(recover);
  const [error, setError] = useState(copy?.draft?.error || '');
  const [storageError, setStorageError] = useState('');
  const [notice, setNotice] = useState(copy ? 'Recovered your working copy.' : '');
  const [busy, setBusy] = useState(false);
  const [comparison, setComparison] = useState<{
    revision: string;
    newChange?: boolean;
    documents: { path: string; content: string | null }[];
  } | null>(null);
  const [gate, setGate] = useState<{
    canAccept?: boolean;
    reason?: string;
    currentHead?: string;
  } | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [position, setPosition] = useState(0);
  const current = useRef(copy);
  current.current = copy;
  const inFlight = useRef(false);
  const selected = copy?.documents.find((d) => d.path === copy.selected);
  const dirty = !!copy && JSON.stringify(copy.documents) !== copy.saved;
  const canSave =
    !!copy &&
    copy.documents.length > 0 &&
    !copy.forkNeedsComparison &&
    !comparison?.documents.some((document) => document.content === null) &&
    !copy.initialSaveConflict &&
    (!copy.draft || copy.draft.state === 'draft' || copy.draft.state === 'in-review') &&
    (dirty ||
      !!copy.pendingCreate ||
      (!!copy.draft && !!catalog?.reviewEnabled && needsReview(copy.draft)));
  useEffect(() => {
    let active = true;
    request<KnowledgeCatalog>('/api/knowledge')
      .then((data) => {
        if (active) setCatalog(data);
      })
      .catch((err: Error) => {
        if (active) setError(err.message);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const active = current.current?.documents.find((d) => d.path === current.current?.selected);
    setHistory(active ? [active.content] : []);
    setPosition(0);
  }, [copy?.selected]);
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    const navigate = (event: MouseEvent) => {
      const link = (event.target as Element)?.closest?.('a[href]');
      if (!link || link.getAttribute('target') === '_blank' || event.ctrlKey || event.metaKey)
        return;
      if (
        !window.confirm('Leave this editor? Your working copy will be recovered when you return.')
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', unload);
    document.addEventListener('click', navigate, true);
    return () => {
      window.removeEventListener('beforeunload', unload);
      document.removeEventListener('click', navigate, true);
    };
  }, [dirty]);
  function persist(next: WorkingCopy | null) {
    current.current = next;
    setCopy(next);
    try {
      if (next) localStorage.setItem(storageKey, JSON.stringify(next));
      else localStorage.removeItem(storageKey);
      setStorageError('');
    } catch {
      setStorageError(
        'Your latest changes could not be backed up on this device. Save before leaving.',
      );
    }
  }
  async function run(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Operation failed. Your changes are preserved.',
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function installDraft(draft: KnowledgeDraft) {
    const next = {
      title: draft.title,
      baseRevision: draft.baseRevision,
      draft,
      documents: draft.documents,
      selected: draft.documents[0]?.path || '',
      saved: JSON.stringify(draft.documents),
    };
    persist(next);
    setHistory([next.documents[0]?.content || '']);
    setPosition(0);
    setGate(null);
    setComparison(null);
  }
  function updateDraft(draft: KnowledgeDraft, reviewError?: string) {
    const old = current.current!;
    persist({
      ...old,
      draft,
      baseRevision: draft.baseRevision,
      documents: draft.documents,
      selected: draft.documents.some((d) => d.path === old.selected)
        ? old.selected
        : draft.documents[0]?.path || '',
      saved: JSON.stringify(draft.documents),
    });
    setCatalog((data) =>
      data ? { ...data, drafts: [draft, ...data.drafts.filter((d) => d.id !== draft.id)] } : data,
    );
    setNotice(
      draft.state === 'accepted'
        ? 'Accepted · Waiting for publication'
        : draft.review?.version === draft.version
          ? draft.review.ready
            ? 'In review'
            : 'Review draft saved'
          : 'Draft saved',
    );
    setError(reviewError || draft.error || '');
    setGate(null);
  }
  async function openDraft(draft: KnowledgeDraftSummary) {
    await run(async () => {
      if (dirty && !window.confirm('Replace your unsaved working copy with this saved draft?'))
        return;
      const result = await request<{ draft: KnowledgeDraft }>(
        `/api/knowledge/drafts/${encodeURIComponent(draft.id)}`,
      );
      if (
        !result.draft?.documents?.length ||
        !result.draft.documents.every(
          (d) => typeof d.content === 'string' && typeof d.base === 'string',
        )
      )
        throw new Error('Saved draft could not be loaded. Your working copy is preserved.');
      installDraft(result.draft);
      setNotice('Saved draft opened');
      setError(result.draft.error || '');
    });
  }
  async function openDocument(document: KnowledgeDocument, add = false) {
    await run(async () => {
      if (!catalog) return;
      if (!add && dirty && !window.confirm('Replace your unsaved working copy with this document?'))
        return;
      const data = await request<{ content: string }>(
        `/api/knowledge/document?${new URLSearchParams({ path: document.path, revision: catalog.revision })}`,
      );
      const item = { path: document.path, base: data.content, content: data.content };
      const old = current.current;
      if (add && old) {
        if (old.documents.length && old.baseRevision !== catalog.revision)
          throw new Error(
            'Refresh and compare this draft before adding a document from the latest library.',
          );
        persist({
          ...old,
          baseRevision: old.documents.length ? old.baseRevision : catalog.revision,
          documents: [...old.documents.filter((d) => d.path !== item.path), item],
          selected: item.path,
        });
      } else
        persist({
          title: document.title,
          baseRevision: catalog.revision,
          documents: [item],
          selected: item.path,
          saved: JSON.stringify([item]),
        });
      setHistory([data.content]);
      setPosition(0);
      setNotice('');
      setComparison(null);
      setGate(null);
    });
  }
  function change(value: string, record = true) {
    const old = current.current;
    if (!old || busy) return;
    persist({
      ...old,
      documents: old.documents.map((d) => (d.path === old.selected ? { ...d, content: value } : d)),
    });
    if (record) {
      const next = [...history.slice(0, position + 1), value].slice(-100);
      let bytes = next.reduce((sum, text) => sum + text.length * 2, 0);
      while (next.length > 1 && bytes > 20 * 1024 * 1024) bytes -= next.shift()!.length * 2;
      setHistory(next);
      setPosition(next.length - 1);
    }
    setGate(null);
  }
  function move(next: number) {
    if (next < 0 || next >= history.length || busy) return;
    change(history[next], false);
    setPosition(next);
  }
  async function loadSavedComparison() {
    const old = current.current;
    if (!old?.initialSaveConflict) return;
    // A failed refresh must not leave stale comparison choices enabled.
    persist({ ...old, savedComparisonUnavailable: true });
    try {
      const result = await request<{ draft: KnowledgeDraft }>(
        `/api/knowledge/drafts/${encodeURIComponent(old.initialSaveConflict.id)}`,
      );
      persist({
        ...current.current!,
        initialSaveConflict: result.draft,
        savedComparisonUnavailable: false,
      });
    } catch {
      throw new Error('Could not load the saved draft. Your working copy is preserved.');
    }
  }
  async function writeSavedDraft(id: string, body: unknown) {
    try {
      return await request<{ draft: KnowledgeDraft; reviewError?: string }>(
        `/api/knowledge/drafts/${encodeURIComponent(id)}`,
        'PUT',
        body,
      );
    } catch (error) {
      if (error instanceof KnowledgeApiError && error.status === 409) {
        const old = current.current;
        const reference = old?.initialSaveConflict || old?.draft;
        if (old && reference) {
          persist({ ...old, initialSaveConflict: reference, savedComparisonUnavailable: true });
          setComparison(null);
          setGate(null);
          await loadSavedComparison();
        }
      }
      throw error;
    }
  }
  async function save(
    baseRevision?: string,
    documents?: KnowledgeDraft['documents'],
    newChange = false,
  ) {
    const active = current.current;
    if (!active || active.initialSaveConflict || !(documents || active.documents).length) return;
    if (active.forkNeedsComparison && !(newChange && baseRevision && documents)) return;
    if (
      comparison?.documents.some(
        (d) =>
          d.content === null &&
          (documents || active.documents).some((candidate) => candidate.path === d.path),
      )
    )
      return;
    const changed =
      JSON.stringify(documents || active.documents) !== active.saved ||
      (!!baseRevision && baseRevision !== active.baseRevision);
    if (
      !newChange &&
      active.draft &&
      (active.draft.state === 'accepted' || active.draft.state === 'closed')
    )
      return;
    // A clean confirmed Save must preserve the reviewed head, readiness and approvals.
    if (
      !newChange &&
      !changed &&
      !active.pendingCreate &&
      (!active.draft || !catalog?.reviewEnabled || !needsReview(active.draft))
    )
      return;
    await run(async () => {
      const old = current.current;
      if (!old) return;
      const contents = (documents || old.documents).map(({ path, content }) => ({ path, content }));
      let result: { draft: KnowledgeDraft; reviewError?: string };
      if (old.draft && !newChange) {
        result = changed
          ? await writeSavedDraft(old.draft.id, {
              version: old.draft.version,
              documents: contents,
              ...(baseRevision || old.baseRevision !== old.draft.baseRevision
                ? { baseRevision: baseRevision || old.baseRevision }
                : {}),
            })
          : await request(
              `/api/knowledge/drafts/${encodeURIComponent(old.draft.id)}/review`,
              'POST',
              { version: old.draft.version },
            );
      } else {
        const creation = old.pendingCreate || {
          requestId: crypto.randomUUID(),
          title: old.title,
          baseRevision: baseRevision || old.baseRevision,
          documents: contents,
        };
        // Keep the exact initial request across uncertain acknowledgements and reloads.
        persist({
          ...old,
          draft: undefined,
          forkNeedsComparison: undefined,
          pendingCreate: creation,
          baseRevision: creation.baseRevision,
          documents: documents || old.documents,
        });
        result = await request('/api/knowledge/drafts', 'POST', creation);
        const returned = result.draft.documents.map(({ path, content }) => ({ path, content }));
        if (
          result.draft.version !== 1 ||
          JSON.stringify(returned) !== JSON.stringify(creation.documents)
        ) {
          // Do not adopt a newer write version until the operator compares and resolves it.
          persist({ ...current.current!, initialSaveConflict: result.draft });
          setComparison(null);
          throw new Error(
            'This saved draft changed elsewhere. Compare it with your preserved working copy before updating it.',
          );
        }
        persist({ ...current.current!, draft: result.draft, pendingCreate: undefined });
        if (JSON.stringify(contents) !== JSON.stringify(creation.documents)) {
          result = await writeSavedDraft(result.draft.id, {
            version: result.draft.version,
            documents: contents,
            ...(baseRevision || old.baseRevision !== result.draft.baseRevision
              ? { baseRevision: baseRevision || old.baseRevision }
              : {}),
          });
          updateDraft(result.draft, result.reviewError);
          setComparison(null);
          return;
        }
        updateDraft(result.draft);
        try {
          result = await request(
            `/api/knowledge/drafts/${encodeURIComponent(result.draft.id)}/review`,
            'POST',
            { version: result.draft.version },
          );
        } catch (err) {
          setError(
            `Draft saved. ${err instanceof Error ? err.message : 'Review could not be opened.'}`,
          );
          return;
        }
      }
      updateDraft(result.draft, result.reviewError);
      setComparison(null);
    });
  }
  async function refreshSavedComparison() {
    await run(loadSavedComparison);
  }
  async function resolveInitialSaveConflict(useSaved: boolean) {
    await run(async () => {
      const old = current.current;
      const remote = old?.initialSaveConflict;
      if (!old || !remote || old.savedComparisonUnavailable) return;
      const matchesSaved =
        old.documents.length === remote.documents.length &&
        old.documents.every((document) =>
          remote.documents.some(
            (saved) => saved.path === document.path && saved.content === document.content,
          ),
        );
      if (useSaved || matchesSaved) {
        installDraft(remote);
        setNotice('Saved draft opened');
        setError(remote.error || '');
        return;
      }
      if (remote.state === 'accepted' || remote.state === 'closed')
        throw new Error(
          'This saved change is finished. Open it to start a new change with your edits.',
        );
      const result = await writeSavedDraft(remote.id, {
        version: remote.version,
        baseRevision: remote.baseRevision,
        documents: old.documents.map(({ path, content }) => ({ path, content })),
      });
      persist({
        ...old,
        draft: result.draft,
        pendingCreate: undefined,
        initialSaveConflict: undefined,
        savedComparisonUnavailable: undefined,
      });
      updateDraft(result.draft, result.reviewError);
    });
  }
  function freshWorkingCopy(
    old: WorkingCopy,
    baseRevision: string,
    documents: WorkingCopy['documents'],
    needsComparison: boolean,
  ) {
    // Copy only local authoring state; remote receipts and pending request identities belong to the old change.
    persist({
      title: old.title,
      baseRevision,
      documents,
      selected: documents.some((d) => d.path === old.selected)
        ? old.selected
        : documents[0]?.path || '',
      saved: old.saved,
      forkNeedsComparison: needsComparison,
    });
    setComparison(null);
    setGate(null);
    setError('');
  }
  async function startNewChangeWithEdits() {
    const old = current.current;
    const remote = old?.initialSaveConflict;
    if (
      !old ||
      old.savedComparisonUnavailable ||
      inFlight.current ||
      (remote ? remote.state !== 'accepted' && remote.state !== 'closed' : !old.draft)
    )
      return;
    freshWorkingCopy(old, old.baseRevision, old.documents, true);
    setNotice(
      'Your edits are preserved in a new change. Compare accepted knowledge before saving.',
    );
    await compare(true);
  }
  async function refresh() {
    await run(async () => {
      setCatalog(await request('/api/knowledge/refresh', 'POST', {}));
    });
  }
  async function compare(newChange = false) {
    await run(async () => {
      setComparison(null);
      const latest = await request<KnowledgeCatalog>('/api/knowledge/refresh', 'POST', {});
      setCatalog(latest);
      const acceptedPaths = new Set(latest.documents.map((document) => document.path));
      const docs = await Promise.all(
        (current.current?.documents || []).map(async (document) => ({
          path: document.path,
          content: acceptedPaths.has(document.path)
            ? (
                await request<{ content: string }>(
                  `/api/knowledge/document?${new URLSearchParams({ path: document.path, revision: latest.revision })}`,
                )
              ).content
            : null,
        })),
      );
      setComparison({
        revision: latest.revision,
        documents: docs,
        newChange: newChange || !!current.current?.forkNeedsComparison,
      });
    });
  }
  async function excludeRemovedDocuments() {
    const old = current.current;
    if (!old || !comparison || old.initialSaveConflict || inFlight.current) return false;
    const retained = old.documents.filter((document) =>
      comparison.documents.some(
        (accepted) => accepted.path === document.path && accepted.content !== null,
      ),
    );
    if (retained.length) {
      await save(comparison.revision, retained, comparison.newChange);
      return false;
    }
    if (comparison.newChange) freshWorkingCopy(old, comparison.revision, [], false);
    else persist({ ...old, baseRevision: comparison.revision, documents: [], selected: '' });
    setComparison(null);
    setGate(null);
    setError('');
    setNotice('Removed documents excluded. Add a current Library document to continue.');
    return true;
  }
  async function reconcile() {
    await run(async () => {
      const draft = current.current?.draft;
      if (!draft || current.current?.initialSaveConflict) return;
      const result = await request<{
        draft: KnowledgeDraft;
        canAccept?: boolean;
        reason?: string;
        currentHead?: string;
      }>(`/api/knowledge/drafts/${encodeURIComponent(draft.id)}/reconcile`, 'POST', {});
      updateDraft(result.draft);
      setGate(result);
    });
  }
  async function sendForReview() {
    await run(async () => {
      const old = current.current;
      const draft = old?.draft;
      if (
        !old ||
        old.initialSaveConflict ||
        !draft?.review ||
        draft.review.version !== draft.version ||
        draft.review.ready ||
        (draft.state !== 'draft' && draft.state !== 'in-review') ||
        JSON.stringify(old.documents) !== old.saved
      )
        return;
      const result = await request<{ draft: KnowledgeDraft }>(
        `/api/knowledge/drafts/${encodeURIComponent(draft.id)}/ready`,
        'POST',
        { version: draft.version, head: draft.review.head },
      );
      updateDraft(result.draft);
      setNotice('Sent for review');
    });
  }
  async function accept() {
    await run(async () => {
      const draft = current.current?.draft;
      if (!draft?.review || !gate?.canAccept || dirty || current.current?.initialSaveConflict)
        return;
      const result = await request<{ draft: KnowledgeDraft }>(
        `/api/knowledge/drafts/${encodeURIComponent(draft.id)}/accept`,
        'POST',
        { version: draft.version, head: draft.review.head },
      );
      updateDraft(result.draft);
    });
  }
  return {
    catalog,
    copy,
    selected,
    dirty,
    canSave,
    busy,
    error,
    storageError,
    notice,
    comparison,
    gate,
    openDocument,
    openDraft,
    change,
    save,
    refresh,
    refreshSavedComparison,
    resolveInitialSaveConflict,
    startNewChangeWithEdits,
    compare,
    excludeRemovedDocuments,
    reconcile,
    sendForReview,
    accept,
    select: (path: string) => {
      if (copy && !busy) persist({ ...copy, selected: path });
    },
    undo: () => move(position - 1),
    redo: () => move(position + 1),
    canUndo: position > 0,
    canRedo: position < history.length - 1,
    discard: () => {
      if (!busy && window.confirm('Discard this working copy? Saved drafts stay in the library.')) {
        persist(null);
        setNotice('');
        setError('');
      }
    },
  };
}
