import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TelosWorkApiClient } from '@mitzo/client';
import { useMitzoStore } from '@mitzo/client/hooks';
import type { TelosWorkView } from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import { createChatDraft, saveChatDraft } from '../lib/chat-drafts';

const api = new TelosWorkApiClient(apiFetch);
/** Narrow ordinary setup entry. Role selection does not allocate or send. */
export function TelosItemRoleEntries({
  itemId,
  onOrdinaryRoles,
}: {
  itemId: string;
  onOrdinaryRoles?(itemId: string, available: boolean): void;
}) {
  const navigate = useNavigate();
  const newSession = useMitzoStore((s) => s.newSession);
  const [result, setResult] = useState<{ itemId: string; work?: TelosWorkView; error?: string }>();
  const [saveError, setSaveError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api.read(itemId, controller.signal).then(
      (work) => {
        if (!controller.signal.aborted) {
          setResult({ itemId, work });
          onOrdinaryRoles?.(itemId, work.kind === 'outcome' || work.kind === 'work_item');
        }
      },
      () => {
        if (!controller.signal.aborted)
          setResult({ itemId, error: 'Conversation setup unavailable.' });
      },
    );
    return () => controller.abort();
  }, [itemId, attempt, onOrdinaryRoles]);
  if (result?.itemId !== itemId) return <p role="status">Loading conversations…</p>;
  if (result.error)
    return (
      <div role="alert">
        {result.error}{' '}
        <button className="todo-detail-chat-btn" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  const work = result.work!;
  // Kind is explicit. Legacy null kinds and coordinator setup belong to their owners.
  if (work.kind !== 'outcome' && work.kind !== 'work_item') return null;
  const role = work.kind === 'outcome' ? 'lead' : 'worker';
  const hasOrigin =
    work.links.some((link) => link.role === 'origin') ||
    work.sources.some((source) => source.source !== null);
  const assignment = work.assignments.find((value) => value.role === role);
  const available =
    assignment &&
    work.links.some(
      (link) =>
        link.role === role &&
        link.conversation.conversationId === assignment.conversation.conversationId &&
        link.availability === 'available',
    );
  function configure(
    selectedRole: 'lead' | 'worker' | 'advisor',
    mode: 'assign' | 'additional',
    purpose?: 'refine' | 'child',
  ) {
    const draft = createChatDraft();
    const params = new URLSearchParams({
      telosRoleItem: itemId,
      telosRole: selectedRole,
      telosRoleMode: mode,
    });
    if (purpose) params.set('telosAdvisor', purpose);
    draft.settings = { ...draft.settings, search: params.toString(), retainRuntimeIntent: true };
    if (!saveChatDraft(draft)) {
      setSaveError('Chat setup could not be saved on this device.');
      return;
    }
    params.set('draft', draft.id);
    newSession();
    navigate(`/chat?${params}`);
  }
  return (
    <section
      className="todo-detail-contract"
      aria-label={role === 'lead' ? 'Lead collaborator' : 'Worker session'}
    >
      <h2>{role === 'lead' ? 'Lead collaborator' : 'Worker session'}</h2>
      {!assignment && (
        <p>
          {role === 'lead'
            ? `${hasOrigin ? 'The originating conversation is linked. ' : ''}Choose a lead to collaborate on the plan, delegate slices and review results.`
            : 'Choose a worker through ordinary chat settings.'}
        </p>
      )}
      {role === 'lead' && assignment && (
        <p>
          Collaborate on the plan, maintain the brief, delegate each slice to its own worker chat,
          coordinate dependencies and review returned evidence.
        </p>
      )}
      {saveError && <p role="alert">{saveError}</p>}
      <div className="todo-detail-actions">
        {assignment ? (
          <>
            <button
              className="todo-detail-chat-btn"
              disabled={!available}
              onClick={() =>
                navigate(`/chat/${encodeURIComponent(assignment.conversation.conversationId)}`)
              }
            >
              Open {role} chat
            </button>
            <button className="todo-detail-chat-btn" onClick={() => configure(role, 'additional')}>
              New chat
            </button>
            <button className="todo-detail-chat-btn" onClick={() => configure(role, 'assign')}>
              Change {role === 'lead' ? 'lead collaborator' : 'worker'}
            </button>
          </>
        ) : (
          <button className="todo-detail-chat-btn" onClick={() => configure(role, 'assign')}>
            Choose {role === 'lead' ? 'lead collaborator' : 'worker'}
          </button>
        )}
        <button
          className="todo-detail-chat-btn"
          onClick={() => configure('advisor', 'additional', 'refine')}
        >
          Refine item
        </button>
        <button
          className="todo-detail-chat-btn"
          onClick={() => configure('advisor', 'additional', 'child')}
        >
          Add child with advisor
        </button>
      </div>
      {assignment && !available && (
        <p role="status">Assigned conversation unavailable. Its history remains linked.</p>
      )}
    </section>
  );
}
