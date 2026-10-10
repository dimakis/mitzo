import { useCallback, useEffect, useRef, useState } from 'react';
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
  documents: { path: string; sourcePath?: string; content: string }[];
  directories?: string[];
}
interface WorkingCopy {
  title: string;
  baseRevision: string;
  draft?: KnowledgeDraft;
  pendingCreate?: DraftCreation;
  initialSaveConflict?: KnowledgeDraft;
  savedComparisonUnavailable?: boolean;
  forkNeedsComparison?: boolean;
  forkAccepted?: KnowledgeDraft;
  documents: KnowledgeDraft['documents'];
  directories: string[];
  selected: string;
  saved: string;
  savedDirectories?: string[];
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
          typeof d.path === 'string' &&
          typeof d.base === 'string' &&
          typeof d.content === 'string' &&
          (d.sourcePath === undefined || typeof d.sourcePath === 'string'),
      ) &&
      (value.directories === undefined ||
        (Array.isArray(value.directories) &&
          value.directories.every((path: unknown) => typeof path === 'string')))
      ? {
          ...value,
          directories: value.directories || [],
          savedDirectories: value.savedDirectories || value.draft?.directories || [],
        }
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
  const [historyResetKey, setHistoryResetKey] = useState(0);
  const resetHistory = useCallback((content: string | null) => {
    setHistory(content === null ? [] : [content]);
    setPosition(0);
    setHistoryResetKey((key) => key + 1);
  }, []);
  const current = useRef(copy);
  current.current = copy;
  const inFlight = useRef(false);
  const selected = copy?.documents.find((d) => d.path === copy.selected);
  const dirty =
    !!copy &&
    (JSON.stringify(copy.documents) !== copy.saved ||
      JSON.stringify(copy.directories) !== JSON.stringify(copy.savedDirectories || []));
  const canSave =
    !!copy &&
    (copy.documents.length > 0 || copy.directories.length > 0) &&
    !copy.forkNeedsComparison &&
    !comparison?.documents.some((document) => document.content === null) &&
    !copy.initialSaveConflict &&
    (!copy.draft || copy.draft.state === 'draft' || copy.draft.state === 'in-review') &&
    (dirty || !!copy.pendingCreate);
  const canSendForReview =
    !!copy?.draft &&
    !!catalog?.reviewEnabled &&
    !dirty &&
    !copy.pendingCreate &&
    !copy.forkNeedsComparison &&
    !copy.initialSaveConflict &&
    !comparison?.documents.some((document) => document.content === null) &&
    (copy.draft.state === 'draft' || copy.draft.state === 'in-review') &&
    !(copy.draft.review?.version === copy.draft.version && copy.draft.review.ready);
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
    resetHistory(active?.content ?? null);
  }, [copy?.selected, resetHistory]);
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
      directories: draft.directories || [],
      savedDirectories: draft.directories || [],
      selected: draft.documents[0]?.path || '',
      saved: JSON.stringify(draft.documents),
    };
    persist(next);
    resetHistory(next.documents[0]?.content ?? '');
    setGate(null);
    setComparison(null);
  }
  function updateDraft(draft: KnowledgeDraft, reviewError?: string, preserveAuthoring = false) {
    const old = current.current!;
    persist({
      ...old,
      draft,
      baseRevision: preserveAuthoring ? old.baseRevision : draft.baseRevision,
      documents: preserveAuthoring ? old.documents : draft.documents,
      directories: preserveAuthoring ? old.directories : draft.directories || [],
      savedDirectories: preserveAuthoring ? old.savedDirectories : draft.directories || [],
      selected:
        preserveAuthoring || draft.documents.some((d) => d.path === old.selected)
          ? old.selected
          : draft.documents[0]?.path || '',
      saved: preserveAuthoring ? old.saved : JSON.stringify(draft.documents),
    });
    setCatalog((data) =>
      data ? { ...data, drafts: [draft, ...data.drafts.filter((d) => d.id !== draft.id)] } : data,
    );
    setNotice(
      draft.state === 'accepted'
        ? 'Accepted · Waiting for publication'
        : draft.review?.version === draft.version
          ? draft.review.ready
            ? 'Sent for review'
            : 'Draft saved'
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
        !Array.isArray(result.draft?.documents) ||
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
    let opened = false;
    await run(async () => {
      if (!catalog) return;
      const staged = current.current?.documents.find(
        (d) => d.path === document.path || d.sourcePath === document.path,
      );
      if (staged) {
        persist({ ...current.current!, selected: staged.path });
        resetHistory(staged.content);
        opened = true;
        return;
      }
      if (
        add &&
        (current.current?.draft?.state === 'accepted' || current.current?.draft?.state === 'closed')
      )
        throw new Error('Start a new change before adding documents to this finished draft.');
      if (!add && dirty && !window.confirm('Replace your unsaved working copy with this document?'))
        return;
      const data = await request<{ content: string }>(
        `/api/knowledge/document?${new URLSearchParams({ path: document.path, revision: catalog.revision })}`,
      );
      const item = { path: document.path, base: data.content, content: data.content };
      const existing = current.current?.documents.find(
        (d) => d.path === item.path || d.sourcePath === item.path,
      );
      if (add && existing) {
        persist({ ...current.current!, selected: existing.path });
        resetHistory(existing.content);
        opened = true;
        return;
      }
      const old = current.current;
      if (add && old) {
        if (
          (old.documents.length || old.directories.length) &&
          old.baseRevision !== catalog.revision
        )
          throw new Error(
            'Refresh and compare this draft before adding a document from the latest library.',
          );
        persist({
          ...old,
          baseRevision:
            old.documents.length || old.directories.length ? old.baseRevision : catalog.revision,
          documents: [...old.documents.filter((d) => d.path !== item.path), item],
          selected: item.path,
        });
      } else
        persist({
          title: document.title,
          baseRevision: catalog.revision,
          documents: [item],
          directories: [],
          selected: item.path,
          saved: JSON.stringify([item]),
        });
      opened = true;
      resetHistory(data.content);
      setNotice('');
      setComparison(null);
      setGate(null);
    });
    return opened;
  }
  async function readDocument(document: KnowledgeDocument) {
    const staged = current.current?.documents.find((d) => d.path === document.path);
    if (staged) return { content: staged.content };
    if (!catalog) return;
    return request<{ content: string }>(
      `/api/knowledge/document?${new URLSearchParams({ path: document.path, revision: catalog.revision })}`,
    );
  }
  function validPath(path: string) {
    const reserved = new Set([
      '__pycache__',
      'node_modules',
      'scripts',
      'tests',
      'worktrees',
      'dist',
      'runtime',
      'logs',
      'coverage',
      'build',
    ]);
    return (
      path.length <= 512 &&
      /^[\p{L}\p{N}_ /().-]+$/u.test(path) &&
      path
        .split('/')
        .every(
          (part) =>
            !!part &&
            new TextEncoder().encode(part).length <= 255 &&
            part.trim() === part &&
            part !== '.' &&
            part !== '..' &&
            !part.startsWith('.') &&
            !reserved.has(part.toLowerCase()),
        )
    );
  }
  function directoryScope(path: string) {
    const scopes =
      catalog?.documentPaths ||
      (catalog?.directories || []).filter((directory) => !directory.includes('/'));
    return scopes
      .filter((scope) => !scope.endsWith('.md') && path.startsWith(scope + '/'))
      .sort((a, b) => b.length - a.length)[0];
  }
  function privateBoundary(path: string) {
    const segments = path.split('/');
    const index = segments.findIndex((segment) => /^private(?:[_-]|$)/i.test(segment));
    return index < 0 ? '' : segments.slice(0, index + 1).join('/');
  }
  function canMoveDocument(from: string, to: string) {
    const document = current.current?.documents.find((d) => d.path === from);
    const source = document?.sourcePath || from;
    if (catalog?.documentPaths?.some((scope) => scope.endsWith('.md') && scope === source))
      return false;
    const scope = directoryScope(source);
    return (
      validPath(to) &&
      to.endsWith('.md') &&
      !!scope &&
      directoryScope(to) === scope &&
      source.split('/')[0] === to.split('/')[0] &&
      privateBoundary(source) === privateBoundary(to) &&
      !current.current?.documents.some((d) => d.path === to && d.path !== from) &&
      (!catalog?.documents.some((d) => d.path === to) || to === source || to === from)
    );
  }
  function directoryOccupied(path: string) {
    const inside = (candidate: string) => candidate === path || candidate.startsWith(path + '/');
    return (
      !!catalog?.directories?.some(inside) ||
      !!current.current?.directories.some(inside) ||
      !!catalog?.documents.some((document) => inside(document.path)) ||
      !!current.current?.documents.some((document) => inside(document.path))
    );
  }
  function canCreateInDirectory(parent: string) {
    return (
      validPath(parent) &&
      !!directoryScope(parent + '/document.md') &&
      !catalog?.documents.some((document) => document.path === parent) &&
      !current.current?.documents.some((document) => document.path === parent)
    );
  }
  function canCreateDirectory(path: string) {
    const scope = directoryScope(path + '/document.md');
    return validPath(path) && !!scope && path !== scope && !directoryOccupied(path);
  }
  function moveDocument(from: string, to: string) {
    const old = current.current;
    if (!old || inFlight.current) return false;
    if (from === to) return true;
    const document = old.documents.find((d) => d.path === from);
    if (!document) return false;
    const source = document.sourcePath || document.path;
    if (!canMoveDocument(from, to)) {
      setError('Choose an unused document path in the same knowledge scope.');
      return false;
    }
    persist({
      ...old,
      documents: old.documents.map((d) => {
        if (d !== document) return d;
        const moved = { ...d, path: to };
        if (to === source) delete moved.sourcePath;
        else moved.sourcePath = source;
        return moved;
      }),
      selected: old.selected === from ? to : old.selected,
    });
    setComparison(null);
    setGate(null);
    return true;
  }
  async function moveAcceptedDocument(document: KnowledgeDocument, target: string) {
    if (!catalog || inFlight.current) return false;
    const staged = current.current?.documents.find(
      (item) => item.path === document.path || item.sourcePath === document.path,
    );
    if (staged) return moveDocument(staged.path, target);
    if (document.path === target || !canMoveDocument(document.path, target)) {
      setError('Choose an unused document path in the same knowledge scope.');
      return false;
    }
    let moved = false;
    await run(async () => {
      const old = current.current;
      if (
        old &&
        (old.documents.length || old.directories.length) &&
        old.baseRevision !== catalog.revision
      )
        throw new Error(
          'Refresh and compare this draft before moving a document from the latest library.',
        );
      const data = await request<{ content: string }>(
        `/api/knowledge/document?${new URLSearchParams({ path: document.path, revision: catalog.revision })}`,
      );
      const item = {
        path: target,
        sourcePath: document.path,
        base: data.content,
        content: data.content,
      };
      persist(
        old
          ? {
              ...old,
              documents: [...old.documents, item],
              selected: target,
              baseRevision:
                old.documents.length || old.directories.length
                  ? old.baseRevision
                  : catalog.revision,
            }
          : {
              title: document.title,
              baseRevision: catalog.revision,
              documents: [item],
              directories: [],
              selected: target,
              saved: JSON.stringify([
                { path: document.path, base: data.content, content: data.content },
              ]),
            },
      );
      resetHistory(data.content);
      setComparison(null);
      setGate(null);
      moved = true;
    });
    return moved;
  }
  function createDirectory(path: string) {
    if (!catalog || inFlight.current) return false;
    if (directoryOccupied(path)) {
      setError('This folder or path already exists. Choose a new folder name.');
      return false;
    }
    if (!canCreateDirectory(path)) {
      setError('Choose a folder inside an existing knowledge scope.');
      return false;
    }
    const old = current.current;
    persist(
      old
        ? { ...old, directories: [...old.directories, path] }
        : {
            title: 'Organize knowledge',
            baseRevision: catalog.revision,
            documents: [],
            directories: [path],
            selected: '',
            saved: '[]',
            savedDirectories: [],
          },
    );
    setGate(null);
    return true;
  }
  async function removeDirectory(path: string) {
    const old = current.current;
    if (
      !old ||
      inFlight.current ||
      old.initialSaveConflict ||
      old.draft?.state === 'accepted' ||
      old.draft?.state === 'closed' ||
      !old.directories.includes(path)
    )
      return false;
    let removed = false;
    await run(async () => {
      let active = current.current!;
      if (active.pendingCreate) {
        const creation = active.pendingCreate;
        const result = await request<{ draft: KnowledgeDraft }>(
          '/api/knowledge/drafts',
          'POST',
          creation,
        );
        const returned = result.draft.documents.map(({ path, sourcePath, content }) => ({
          path,
          ...(sourcePath ? { sourcePath } : {}),
          content,
        }));
        if (
          result.draft.id !== creation.requestId ||
          result.draft.version !== 1 ||
          result.draft.title !== creation.title ||
          result.draft.baseRevision !== creation.baseRevision ||
          JSON.stringify(returned) !== JSON.stringify(creation.documents) ||
          JSON.stringify(result.draft.directories || []) !==
            JSON.stringify(creation.directories || [])
        ) {
          persist({ ...active, initialSaveConflict: result.draft });
          throw new Error(
            'This saved draft changed elsewhere. Compare it before removing folders.',
          );
        }
        active = {
          ...active,
          draft: result.draft,
          pendingCreate: undefined,
          saved: JSON.stringify(result.draft.documents),
          savedDirectories: result.draft.directories || [],
        };
        persist(active);
      }
      const remaining = active.directories.filter((directory) => directory !== path);
      if (active.draft && !active.documents.length && !remaining.length) {
        if (active.draft.documents.length)
          throw new Error(
            'Save the document removal before cancelling this folder-only change. Your saved document review and folder are preserved.',
          );
        try {
          const result = await request<{ draft: KnowledgeDraft }>(
            `/api/knowledge/drafts/${encodeURIComponent(active.draft.id)}/cancel`,
            'POST',
            { version: active.draft.version },
          );
          if (
            result.draft.id !== active.draft.id ||
            result.draft.version !== active.draft.version ||
            result.draft.state !== 'closed'
          )
            throw new Error(
              'Cancellation could not be confirmed. Your saved folder change is preserved.',
            );
          updateDraft(result.draft);
          persist({ ...current.current!, directories: [], savedDirectories: [] });
          setNotice('Saved change cancelled.');
        } catch (error) {
          if (error instanceof KnowledgeApiError && error.status === 409) {
            persist({
              ...active,
              initialSaveConflict: active.draft,
              savedComparisonUnavailable: true,
            });
            setComparison(null);
            setGate(null);
            await loadSavedComparison();
          }
          throw error;
        }
      } else persist({ ...active, directories: remaining });
      setGate(null);
      removed = true;
    });
    return removed;
  }
  function change(value: string, record = true) {
    const old = current.current;
    if (!old || inFlight.current) return;
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
    if (
      !active ||
      active.initialSaveConflict ||
      !((documents || active.documents).length || active.directories.length)
    )
      return;
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
      JSON.stringify(active.directories) !== JSON.stringify(active.savedDirectories || []) ||
      (!!baseRevision && baseRevision !== active.baseRevision);
    if (
      !newChange &&
      active.draft &&
      (active.draft.state === 'accepted' || active.draft.state === 'closed')
    )
      return;
    // A clean confirmed Save must preserve the reviewed head, readiness and approvals.
    if (!newChange && !changed && !active.pendingCreate) return;
    await run(async () => {
      const old = current.current;
      if (!old) return;
      const contents = (documents || old.documents).map(({ path, sourcePath, content }) => ({
        path,
        ...(sourcePath ? { sourcePath } : {}),
        content,
      }));
      let result: { draft: KnowledgeDraft; reviewError?: string };
      if (old.draft && !newChange) {
        result = await writeSavedDraft(old.draft.id, {
          version: old.draft.version,
          documents: contents,
          directories: old.directories,
          ...(baseRevision || old.baseRevision !== old.draft.baseRevision
            ? { baseRevision: baseRevision || old.baseRevision }
            : {}),
        });
      } else {
        const creation = old.pendingCreate || {
          requestId: crypto.randomUUID(),
          title: old.title,
          baseRevision: baseRevision || old.baseRevision,
          documents: contents,
          directories: old.directories,
        };
        // Keep the exact initial request across uncertain acknowledgements and reloads.
        persist({
          ...old,
          draft: undefined,
          forkNeedsComparison: undefined,
          forkAccepted: undefined,
          pendingCreate: creation,
          baseRevision: creation.baseRevision,
          documents: documents || old.documents,
        });
        result = await request('/api/knowledge/drafts', 'POST', creation);
        const returned = result.draft.documents.map(({ path, sourcePath, content }) => ({
          path,
          ...(sourcePath ? { sourcePath } : {}),
          content,
        }));
        if (
          result.draft.version !== 1 ||
          JSON.stringify(returned) !== JSON.stringify(creation.documents) ||
          JSON.stringify(result.draft.directories || []) !==
            JSON.stringify(creation.directories || [])
        ) {
          // Do not adopt a newer write version until the operator compares and resolves it.
          persist({ ...current.current!, initialSaveConflict: result.draft });
          setComparison(null);
          throw new Error(
            'This saved draft changed elsewhere. Compare it with your preserved working copy before updating it.',
          );
        }
        persist({ ...current.current!, draft: result.draft, pendingCreate: undefined });
        if (
          JSON.stringify(contents) !== JSON.stringify(creation.documents) ||
          JSON.stringify(old.directories) !== JSON.stringify(creation.directories || [])
        ) {
          result = await writeSavedDraft(result.draft.id, {
            version: result.draft.version,
            documents: contents,
            directories: old.directories,
            ...(baseRevision || old.baseRevision !== result.draft.baseRevision
              ? { baseRevision: baseRevision || old.baseRevision }
              : {}),
          });
          updateDraft(result.draft, result.reviewError);
          setComparison(null);
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
        JSON.stringify(old.directories) === JSON.stringify(remote.directories || []) &&
        old.documents.length === remote.documents.length &&
        old.documents.every((document) =>
          remote.documents.some(
            (saved) =>
              saved.path === document.path &&
              saved.sourcePath === document.sourcePath &&
              saved.content === document.content,
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
        directories: old.directories,
        documents: old.documents.map(({ path, sourcePath, content }) => ({
          path,
          ...(sourcePath ? { sourcePath } : {}),
          content,
        })),
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
      directories: old.directories,
      savedDirectories: old.savedDirectories,
      selected: documents.some((d) => d.path === old.selected)
        ? old.selected
        : documents[0]?.path || '',
      saved: old.saved,
      forkNeedsComparison: needsComparison,
      forkAccepted:
        (old.initialSaveConflict || old.draft)?.state === 'accepted'
          ? old.initialSaveConflict || old.draft
          : old.forkAccepted,
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
      const old = current.current;
      if (old?.forkAccepted) {
        const accepted = old.forkAccepted;
        const documents = await Promise.all(
          old.documents.map(async (document) => {
            const receipt = accepted.documents.find(
              (saved) =>
                saved.sourcePath &&
                (saved.sourcePath === document.sourcePath || saved.path === document.path),
            );
            if (!receipt || !acceptedPaths.has(receipt.path)) return document;
            const data = await request<{ content: string }>(
              `/api/knowledge/document?${new URLSearchParams({ path: receipt.path, revision: latest.revision })}`,
            );
            if (data.content !== receipt.content) return document;
            const normalized = { ...document, base: data.content };
            if (document.path === receipt.path) delete normalized.sourcePath;
            else normalized.sourcePath = receipt.path;
            return normalized;
          }),
        );
        persist({
          ...old,
          documents,
          directories: old.directories.filter(
            (directory) =>
              !accepted.directories?.includes(directory) ||
              !latest.directories?.includes(directory),
          ),
          savedDirectories: [],
        });
      }
      const docs = await Promise.all(
        (current.current?.documents || []).map(async (document) => ({
          path: document.path,
          content: acceptedPaths.has(document.sourcePath || document.path)
            ? (
                await request<{ content: string }>(
                  `/api/knowledge/document?${new URLSearchParams({ path: document.sourcePath || document.path, revision: latest.revision })}`,
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
      if (!draft || dirty || current.current?.initialSaveConflict) return;
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
        !draft ||
        !catalog?.reviewEnabled ||
        old.initialSaveConflict ||
        old.pendingCreate ||
        old.forkNeedsComparison ||
        comparison?.documents.some((document) => document.content === null) ||
        (draft.state !== 'draft' && draft.state !== 'in-review') ||
        (draft.review?.version === draft.version && draft.review.ready) ||
        JSON.stringify(old.documents) !== old.saved ||
        JSON.stringify(old.directories) !== JSON.stringify(old.savedDirectories || [])
      )
        return;
      try {
        const result = await request<{ draft: KnowledgeDraft }>(
          `/api/knowledge/drafts/${encodeURIComponent(draft.id)}/ready`,
          'POST',
          { version: draft.version },
        );
        if (
          result.draft.id !== draft.id ||
          result.draft.version !== draft.version ||
          result.draft.state !== 'in-review' ||
          result.draft.review?.version !== draft.version ||
          result.draft.review.ready !== true
        )
          throw new Error(
            'Review submission could not be confirmed. Your saved draft is preserved.',
          );
        const active = current.current;
        if (active?.draft?.id !== draft.id || active.draft.version !== draft.version)
          throw new Error(
            'The working copy changed while sending. Refresh its saved review before continuing.',
          );
        updateDraft(result.draft, undefined, true);
        setNotice('Sent for review');
      } catch (error) {
        if (
          error instanceof KnowledgeApiError &&
          error.status === 409 &&
          current.current?.draft?.id === draft.id &&
          current.current.draft.version === draft.version
        ) {
          persist({
            ...current.current,
            initialSaveConflict: draft,
            savedComparisonUnavailable: true,
          });
          setComparison(null);
          setGate(null);
          await loadSavedComparison();
          const active = current.current;
          const saved = active?.initialSaveConflict;
          // A submission conflict can be against accepted knowledge rather than
          // another saved draft. Keep accepted comparison reachable in that case,
          // including after recovering this working copy in a later visit.
          if (
            active &&
            saved?.id === draft.id &&
            saved.version === draft.version &&
            saved.baseRevision === draft.baseRevision &&
            (saved.state === 'draft' || saved.state === 'in-review') &&
            JSON.stringify(saved.documents) === JSON.stringify(draft.documents) &&
            JSON.stringify(saved.directories || []) === JSON.stringify(draft.directories || [])
          ) {
            persist({
              ...active,
              draft: { ...saved, error: error.message },
              initialSaveConflict: undefined,
              savedComparisonUnavailable: false,
            });
          }
        }
        throw error;
      }
    });
  }
  async function accept() {
    await run(async () => {
      const draft = current.current?.draft;
      if (
        !draft?.review ||
        draft.review.version !== draft.version ||
        !draft.review.ready ||
        !gate?.canAccept ||
        (gate.currentHead !== undefined && gate.currentHead !== draft.review.head) ||
        dirty ||
        current.current?.initialSaveConflict
      )
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
    canSendForReview,
    historyResetKey,
    busy,
    error,
    storageError,
    notice,
    comparison,
    gate,
    openDocument,
    readDocument,
    moveDocument,
    moveAcceptedDocument,
    canMoveDocument,
    canCreateDirectory,
    canCreateInDirectory,
    createDirectory,
    removeDirectory,
    removePendingDirectory: removeDirectory,
    directories: [...new Set([...(catalog?.directories || []), ...(copy?.directories || [])])],
    pendingDirectories: copy?.directories || [],
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
      if (current.current && !inFlight.current) persist({ ...current.current, selected: path });
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
