import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { TelosWorkApiClient } from '@mitzo/client';
import { useMitzoStore } from '@mitzo/client/hooks';
import {
  TelosWorkRoleContextSelectionSchema,
  TelosWorkAdvisorDraftProposalSchema,
  TelosWorkAdvisorDraftSaveRequestSchema,
  TelosWorkCommandReceiptSchema,
  type TelosWorkRoleContextSelection,
  type TelosWorkAdvisorDraftSaveRequest,
} from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import { createBrowserId } from '../lib/browser-crypto';
import './RepositoryChatPicker.css';

const api = new TelosWorkApiClient(apiFetch);
const Saved = z.strictObject({
  request: TelosWorkAdvisorDraftSaveRequestSchema,
  receipt: TelosWorkCommandReceiptSchema.nullable(),
});
const transcript = z.object({
  messages: z.array(
    z.object({
      messageId: z.string().min(1),
      completedSeq: z.number().int().positive().optional(),
    }),
  ),
  current: z.unknown().nullable(),
  currents: z.array(z.unknown()).optional(),
  cursor: z.number().int().nonnegative(),
});
const key = (id: string) => `mitzo-telos-advisor-proposal:${encodeURIComponent(id)}`;
type Proposal = z.infer<typeof TelosWorkAdvisorDraftProposalSchema>;
type OpenProposal = {
  conversationId: string;
  value: Proposal;
  expectedRevision: string;
  parentId: string | null;
  expectedParentRevision: string | null;
};
/** A reviewed proposal card inside the ordinary transcript; no execution port. */
export function TelosAdvisorDraft({ conversationId }: { conversationId?: string }) {
  const navigate = useNavigate();
  const running = useMitzoStore((s) => s.messages.running);
  const current = useRef(conversationId);
  current.current = conversationId;
  const [context, setContext] = useState<{
    conversationId: string;
    value: TelosWorkRoleContextSelection;
  }>();
  const [proposal, setProposal] = useState<OpenProposal>();
  const [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const [saved, setSaved] = useState<z.infer<typeof Saved> | null>(null);
  useEffect(() => {
    setProposal(undefined);
    setSaved(null);
    setError('');
    setPending(false);
    if (!conversationId) return;
    const abort = new AbortController();
    void apiFetch(`/api/sessions/${encodeURIComponent(conversationId)}/meta`, {
      signal: abort.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw Error('Advisor unavailable');
        const metadata = await response.json();
        if (metadata.sessionId !== conversationId || !metadata.telosWorkRoleContext) return;
        const value = TelosWorkRoleContextSelectionSchema.parse(metadata.telosWorkRoleContext);
        if (abort.signal.aborted || value.role !== 'advisor') return;
        setContext({ conversationId, value });
        const raw = localStorage.getItem(key(conversationId));
        if (raw) {
          const retained = Saved.parse(JSON.parse(raw));
          if (
            retained.request.advisorConversationId !== conversationId ||
            retained.request.itemId !== value.itemId
          )
            throw Error('Proposal scope changed');
          setSaved(retained);
          setProposal({
            conversationId,
            value: retained.request.proposed,
            expectedRevision: retained.request.expectedRevision,
            parentId: retained.request.parentId,
            expectedParentRevision: retained.request.expectedParentRevision,
          });
        }
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setError('Advisor draft unavailable. The conversation is preserved.');
      });
    return () => abort.abort();
  }, [conversationId]);
  if (!conversationId || context?.conversationId !== conversationId) return null;
  const scope = context.value;
  const operation = scope.advisorPurpose;
  if (operation !== 'refine' && operation !== 'child') return null;
  const fields = proposal?.conversationId === conversationId ? proposal.value : null;
  const remember = (value: z.infer<typeof Saved>) => {
    const encoded = JSON.stringify(value);
    localStorage.setItem(key(conversationId), encoded);
    if (localStorage.getItem(key(conversationId)) !== encoded)
      throw Error('Proposal could not be retained. Nothing has been submitted.');
    setSaved(value);
  };
  const begin = async () => {
    setPending(true);
    setError('');
    try {
      // Fence the record read with the relationship revision: proposal fields
      // and their expected revision must describe the same retained brief.
      const before = await api.read(scope.itemId);
      const record = await api.readRecord(scope.itemId);
      const after = await api.read(scope.itemId);
      if (before.revision !== after.revision)
        throw Error('The work item changed while opening the proposal. Try again.');
      const parentId = operation === 'child' ? scope.itemId : before.parentId;
      const expectedParentRevision =
        operation === 'child'
          ? before.revision
          : parentId
            ? (await api.read(parentId)).revision
            : null;
      if (current.current !== conversationId) return;
      if (record.kind === null) throw Error('Item kind is unavailable.');
      setProposal({
        conversationId,
        expectedRevision: before.revision,
        parentId,
        expectedParentRevision,
        value: {
          name: operation === 'refine' ? record.summary : '',
          desiredOutcome: operation === 'refine' ? record.intent : '',
          type: operation === 'refine' ? record.kind : 'work_item',
          category: record.categories[0] ?? '',
        },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Draft unavailable.');
    } finally {
      if (current.current === conversationId) setPending(false);
    }
  };
  const save = async () => {
    if (pending || running || !fields || !proposal) return;
    setPending(true);
    setError('');
    try {
      let retained = saved;
      if (!retained) {
        const proposed = TelosWorkAdvisorDraftProposalSchema.parse(fields);
        const response = await apiFetch(
          `/api/sessions/${encodeURIComponent(conversationId)}/messages?transcript=1`,
        );
        if (!response.ok) throw Error('The planning discussion is unavailable.');
        const history = transcript.parse(await response.json());
        if (history.current || history.currents?.length || !history.messages.length)
          throw Error('Wait for a completed planning exchange before saving.');
        const last = history.messages.at(-1)!;
        if (last.completedSeq === undefined)
          throw Error('The completed planning exchange boundary is unavailable.');
        const input = {
          requestId: createBrowserId(),
          operation,
          itemId: scope.itemId,
          advisorConversationId: conversationId,
          expectedRevision: proposal.expectedRevision,
          parentId: proposal.parentId,
          expectedParentRevision: proposal.expectedParentRevision,
          proposed,
          selection: {
            requestId: createBrowserId(),
            expectedMembershipRevision: 0,
            sourceConversationId: conversationId,
            mode: 'conversation_so_far' as const,
            boundary: { sequence: last.completedSeq, messageId: last.messageId },
            messageIds: [],
            artifacts: [],
            purpose: 'Save the reviewed advisor draft',
            joiningBrief: '',
          },
        };
        const preview = await api.previewAdvisorDraft(input);
        if (current.current !== conversationId) return;
        const request = TelosWorkAdvisorDraftSaveRequestSchema.parse({
          ...input,
          previewSha256: preview.sha256,
        });
        retained = { request, receipt: null };
        remember(retained);
      }
      const receipt =
        retained.receipt ??
        (await api.saveAdvisorDraft(retained.request as TelosWorkAdvisorDraftSaveRequest));
      if (current.current !== conversationId) return;
      if (receipt.work.itemId !== scope.itemId && operation === 'refine')
        throw Error('Saved refinement identity changed.');
      remember({ ...retained, receipt });
      navigate(`/todos/${encodeURIComponent(receipt.work.itemId)}`);
    } catch (cause) {
      if (current.current === conversationId)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Draft save could not be confirmed. Retry preserves the same request.',
        );
    } finally {
      if (current.current === conversationId) setPending(false);
    }
  };
  const change = (field: keyof Proposal, value: string) => {
    if (fields && proposal && !saved)
      setProposal({ ...proposal, value: { ...fields, [field]: value } });
  };
  return (
    <section
      className="repository-chat-picker repository-chat-picker--transcript"
      aria-label="Advisor proposal"
    >
      {saved?.receipt ? (
        <Link to={`/todos/${encodeURIComponent(saved.receipt.work.itemId)}`}>
          {saved.request.proposed.name}
        </Link>
      ) : !fields ? (
        <>
          <p>
            {operation === 'refine'
              ? 'Let’s refine this item against its parent’s goal and acceptance criteria.'
              : 'Let’s work through the next child item and how it contributes to the overall goal.'}{' '}
            We can discuss it here, inspect the linked materials and agree a draft before saving.
          </p>
          <button
            type="button"
            className="btn-primary"
            disabled={pending || running}
            onClick={() => void begin()}
          >
            {operation === 'refine' ? 'Propose refinement' : 'Suggest a draft'}
          </button>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <h3>{operation === 'refine' ? 'Proposed item refinement' : 'Proposed Telos item'}</h3>
          {operation === 'child' && (
            <label>
              Item type
              <select
                aria-label="Item type"
                disabled={pending || !!saved}
                value={fields.type}
                onChange={(event) => change('type', event.target.value)}
              >
                <option value="outcome">Outcome</option>
                <option value="coordinator">Coordinator</option>
                <option value="work_item">Work item</option>
              </select>
            </label>
          )}
          <label>
            Name
            <input
              aria-label="Name"
              required
              value={fields.name}
              disabled={pending || !!saved}
              onChange={(event) => change('name', event.target.value)}
            />
          </label>
          <label>
            Desired outcome
            <textarea
              aria-label="Desired outcome"
              required
              value={fields.desiredOutcome}
              disabled={pending || !!saved}
              onChange={(event) => change('desiredOutcome', event.target.value)}
            />
          </label>
          <label>
            Category
            <input
              aria-label="Category"
              required
              value={fields.category}
              disabled={pending || !!saved}
              onChange={(event) => change('category', event.target.value)}
            />
          </label>
          <p>Source · this advisor conversation and its reviewed linked brief.</p>
          <button type="submit" className="btn-primary" disabled={pending || running}>
            {operation === 'refine' ? 'Save refinement' : 'Save child draft'}
          </button>
        </form>
      )}
      {pending && <p role="status">{fields ? 'Saving reviewed draft…' : 'Opening draft…'}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
