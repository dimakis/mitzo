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
      value.documents.length &&
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
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await apiFetch(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || 'Knowledge could not be reached. Your changes are preserved.');
  return data;
}
export function useKnowledgeLibrary() {
  const [catalog, setCatalog] = useState<KnowledgeCatalog | null>(null);
  const [copy, setCopy] = useState<WorkingCopy | null>(recover);
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState('');
  const [notice, setNotice] = useState(copy ? 'Recovered your working copy.' : '');
  const [busy, setBusy] = useState(false);
  const [comparison, setComparison] = useState<{
    revision: string;
    newChange?: boolean;
    documents: { path: string; content: string }[];
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
        if (old.baseRevision !== catalog.revision)
          throw new Error(
            'Refresh and compare this draft before adding a document from the latest library.',
          );
        persist({
          ...old,
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
  async function save(
    baseRevision?: string,
    documents?: KnowledgeDraft['documents'],
    newChange = false,
  ) {
    await run(async () => {
      const old = current.current;
      if (!old) return;
      const contents = (documents || old.documents).map(({ path, content }) => ({ path, content }));
      let result: { draft: KnowledgeDraft; reviewError?: string };
      if (old.draft && !newChange)
        result = await request(`/api/knowledge/drafts/${encodeURIComponent(old.draft.id)}`, 'PUT', {
          version: old.draft.version,
          documents: contents,
          ...(baseRevision ? { baseRevision } : {}),
        });
      else {
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
          pendingCreate: creation,
          baseRevision: creation.baseRevision,
          documents: documents || old.documents,
        });
        result = await request('/api/knowledge/drafts', 'POST', creation);
        persist({ ...current.current!, draft: result.draft, pendingCreate: undefined });
        if (JSON.stringify(contents) !== JSON.stringify(creation.documents)) {
          const returned = result.draft.documents.map(({ path, content }) => ({ path, content }));
          if (JSON.stringify(returned) !== JSON.stringify(creation.documents))
            throw new Error(
              'This saved draft changed elsewhere. Your working copy is preserved; compare the saved draft before updating it.',
            );
          result = await request(
            `/api/knowledge/drafts/${encodeURIComponent(result.draft.id)}`,
            'PUT',
            { version: result.draft.version, documents: contents },
          );
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
  async function refresh() {
    await run(async () => {
      setCatalog(await request('/api/knowledge/refresh', 'POST', {}));
    });
  }
  async function compare(newChange = false) {
    await run(async () => {
      const latest = await request<KnowledgeCatalog>('/api/knowledge/refresh', 'POST', {});
      setCatalog(latest);
      const docs = await Promise.all(
        (current.current?.documents || []).map(async (d) => ({
          path: d.path,
          content: (
            await request<{ content: string }>(
              `/api/knowledge/document?${new URLSearchParams({ path: d.path, revision: latest.revision })}`,
            )
          ).content,
        })),
      );
      setComparison({ revision: latest.revision, documents: docs, newChange });
    });
  }
  async function reconcile() {
    await run(async () => {
      const draft = current.current?.draft;
      if (!draft) return;
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
      if (!draft?.review || !gate?.canAccept || dirty) return;
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
    compare,
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
