import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import {
  CollaborationSettingsSchema,
  TelosWorkIdSchema,
  TelosWorkRoleContextSelectionSchema,
  TelosWorkRoleSetupInputSchema,
  TelosWorkCommandReceiptSchema,
  TelosWorkRoleSetupRecoverySchema,
  type CollaborationSettings,
  type TelosWorkRoleContextRequest,
  type TelosWorkCommandReceipt,
} from '@mitzo/protocol';
import { TelosWorkApiError, type TelosWorkApiClient } from '@mitzo/client';
import { createBrowserId } from '../lib/browser-crypto';

const IntentSchema = z
  .strictObject({
    itemId: TelosWorkIdSchema,
    role: z.enum(['lead', 'worker', 'advisor', 'reviewer']),
    mode: z.enum(['assign', 'additional']),
    purpose: z.enum(['refine', 'child']).optional(),
  })
  .refine((value) => ['lead', 'worker'].includes(value.role) || value.mode === 'additional');
export type TelosRoleRouteIntent = z.infer<typeof IntentSchema>;
export function readTelosRoleIntent(params: URLSearchParams): TelosRoleRouteIntent | null {
  const purpose = params.get('telosAdvisor');
  const parsed = IntentSchema.safeParse({
    itemId: params.get('telosRoleItem'),
    role: params.get('telosRole'),
    mode: params.get('telosRoleMode'),
    ...(purpose === 'refine' || purpose === 'child' ? { purpose } : {}),
  });
  return parsed.success ? parsed.data : null;
}

export interface TelosRoleSetupOptions {
  draftId: string | null;
  intent: TelosRoleRouteIntent | null;
  settings: CollaborationSettings | null;
  api: Pick<TelosWorkApiClient, 'roleContext' | 'setupRole' | 'read'>;
  onBound?(conversationId: string): void;
}
const ReviewSchema = z.strictObject({
  settings: CollaborationSettingsSchema,
  context: TelosWorkRoleContextSelectionSchema,
  expectedAssignmentRevision: z.number().int().nonnegative().nullable(),
  priorLinkIds: z.array(z.string()),
});
const StoredSchema = z.strictObject({
  version: z.literal(1),
  draftId: z.string().min(1),
  intent: IntentSchema,
  review: ReviewSchema.nullable(),
  submission: TelosWorkRoleSetupInputSchema.nullable(),
  receipt: TelosWorkCommandReceiptSchema.nullable(),
  rejections: z
    .array(
      z
        .strictObject({
          submission: TelosWorkRoleSetupInputSchema,
          recovery: TelosWorkRoleSetupRecoverySchema,
        })
        .refine(
          ({ submission, recovery }) =>
            submission.requestId === recovery.requestId &&
            recovery.outcome === 'rejected_before_allocation',
        ),
    )
    .default([]),
});
type Saved = z.infer<typeof StoredSchema>;
interface State {
  saved: Saved | null;
  pending: 'review' | 'setup' | null;
  error: string | null;
  storageError: boolean;
  uncertain: boolean;
}
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, child]) => [name, canonical(child)]),
        )
      : value;
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function sameSettings(retained: CollaborationSettings, supplied: CollaborationSettings | null) {
  const parsed = CollaborationSettingsSchema.safeParse(supplied);
  return parsed.success && equal(retained, parsed.data);
}
const key = (id: string) => `mitzo-telos-role-setup:${encodeURIComponent(id)}`;
const rejectedMessage =
  'The reviewed work changed before setup began. Review the updated brief, then confirm again.';
function load(draftId: string | null): State {
  const state: State = {
    saved: null,
    pending: null,
    error: null,
    storageError: false,
    uncertain: false,
  };
  if (!draftId) return state;
  try {
    const raw = localStorage.getItem(key(draftId));
    if (!raw) return state;
    const saved = StoredSchema.parse(JSON.parse(raw));
    if (saved.draftId !== draftId) throw new Error('Draft identity changed');
    return {
      ...state,
      saved,
      uncertain: saved.submission !== null && saved.receipt === null,
      error: saved.rejections.length && !saved.review && !saved.submission ? rejectedMessage : null,
    };
  } catch {
    return {
      ...state,
      storageError: true,
      error:
        'The saved role setup could not be read. Keep this draft to preserve its original request.',
    };
  }
}
function persist(saved: Saved, rejectedRequest?: Saved['submission']) {
  const value = StoredSchema.parse(saved);
  const storageKey = key(saved.draftId);
  const old = localStorage.getItem(storageKey);
  if (old) {
    const previous = StoredSchema.parse(JSON.parse(old));
    if (rejectedRequest && !equal(previous.submission, rejectedRequest) && !equal(previous, value))
      throw new Error('The original request was replaced by a newer retained review or request');
    if (!equal(previous.rejections, value.rejections.slice(0, previous.rejections.length)))
      throw new Error('Role rejection history changed');
    if (previous.receipt && !equal(previous.receipt, value.receipt))
      throw new Error('A confirmed role receipt is already retained');
    if (previous.submission && !equal(previous.submission, value.submission)) {
      const added = value.rejections.slice(previous.rejections.length);
      if (
        value.submission ||
        value.review ||
        value.receipt ||
        previous.receipt ||
        added.length !== 1 ||
        !equal(added[0].submission, previous.submission)
      )
        throw new Error('An original role request is already retained');
    }
  }
  if (
    value.submission &&
    value.rejections.some(({ submission }) => submission.requestId === value.submission!.requestId)
  )
    throw new Error('A rejected role request cannot be resumed');
  const encoded = JSON.stringify(value);
  localStorage.setItem(storageKey, encoded);
  if (localStorage.getItem(storageKey) !== encoded)
    throw new Error('Role request could not be retained');
}
function boundConversation(receipt: TelosWorkCommandReceipt, saved: Saved): string {
  const input = saved.submission!;
  if (receipt.work.itemId !== input.itemId || !saved.review)
    throw new Error('Role receipt scope changed');
  const links = receipt.work.links.filter(
    (link) =>
      link.role === input.role &&
      link.conversation.namespace === 'mitzo' &&
      link.availability === 'available',
  );
  if (input.expectedAssignmentRevision !== null) {
    const assignment = receipt.work.assignments.find((row) => row.role === input.role);
    if (
      !assignment ||
      assignment.revision !== input.expectedAssignmentRevision + 1 ||
      !links.some(
        (link) => link.conversation.conversationId === assignment.conversation.conversationId,
      )
    )
      throw new Error('Selected role assignment was not confirmed');
    return assignment.conversation.conversationId;
  }
  const added = links.filter((link) => !saved.review!.priorLinkIds.includes(link.linkId));
  if (added.length !== 1) throw new Error('Independent role chat was not confirmed');
  return added[0].conversation.conversationId;
}

/** Explicit ordinary setup only. Uncertain requests retain the same UUID,
 * settings and reviewed selection through retry and draft reload. */
export function useTelosRoleSetup(options: TelosRoleSetupOptions) {
  const latest = useRef(options);
  latest.current = options;
  const [state, setState] = useState(() => load(options.draftId));
  const current = useRef(state);
  const draft = useRef(options.draftId);
  const generation = useRef(0);
  const alive = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const update = (next: State) => {
    current.current = next;
    setState(next);
  };
  useEffect(() => {
    const lifecycleGeneration = generation;
    alive.current = true;
    return () => {
      alive.current = false;
      lifecycleGeneration.current++;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (draft.current === options.draftId) return;
    generation.current++;
    controller.current?.abort();
    draft.current = options.draftId;
    update(load(options.draftId));
  }, [options.draftId]);
  const active = (operation: number, draftId: string) =>
    alive.current && generation.current === operation && latest.current.draftId === draftId;
  const review = async (
    selection?: Pick<TelosWorkRoleContextRequest, 'sourceSnapshotIds' | 'artifactRefs'>,
  ) => {
    const selected = latest.current;
    if (
      !selected.draftId ||
      !selected.intent ||
      !selected.settings ||
      current.current.pending ||
      current.current.saved?.submission ||
      current.current.storageError
    )
      return;
    const draftId = selected.draftId;
    const operation = ++generation.current;
    const abort = new AbortController();
    controller.current?.abort();
    controller.current = abort;
    update({ ...current.current, pending: 'review', error: null });
    try {
      const intent = IntentSchema.parse(structuredClone(selected.intent));
      const settings = CollaborationSettingsSchema.parse(structuredClone(selected.settings));
      const work = await selected.api.read(intent.itemId, abort.signal);
      if (!active(operation, draftId)) return;
      const reviewed = work.sources.filter((source) => source.selection.kind === 'selected');
      const pinned = [
        ...new Map(
          reviewed
            .flatMap((source) => source.artifacts)
            .map((pin) => [`${pin.artifactId}:${pin.revision}:${pin.sha256}`, pin]),
        ).values(),
      ];
      const raw = await selected.api.roleContext(
        {
          itemId: intent.itemId,
          role: intent.role,
          ...(intent.role === 'advisor' && intent.purpose
            ? { advisorPurpose: intent.purpose }
            : {}),
          sourceSnapshotIds: structuredClone(
            selection?.sourceSnapshotIds ?? reviewed.map((source) => source.snapshotId),
          ),
          artifactRefs: structuredClone(selection?.artifactRefs ?? pinned),
        },
        abort.signal,
      );
      if (!active(operation, draftId)) return;
      const context = TelosWorkRoleContextSelectionSchema.parse(raw);
      if (
        context.itemId !== intent.itemId ||
        context.role !== intent.role ||
        work.itemId !== intent.itemId ||
        work.revision !== context.brief.revision
      )
        throw new Error('Selected work changed during review');
      const assignment = work.assignments.find((row) => row.role === intent.role);
      const saved: Saved = {
        version: 1,
        draftId,
        intent,
        review: {
          settings,
          context,
          expectedAssignmentRevision: intent.mode === 'assign' ? (assignment?.revision ?? 0) : null,
          priorLinkIds: work.links.map((link) => link.linkId),
        },
        submission: null,
        receipt: null,
        rejections: structuredClone(current.current.saved?.rejections ?? []),
      };
      persist(saved);
      update({ saved, pending: null, error: null, uncertain: false, storageError: false });
    } catch {
      if (active(operation, draftId))
        update({
          ...current.current,
          pending: null,
          error: 'The role context could not be reviewed. Your draft is retained.',
        });
    }
  };
  const submit = async (retry: boolean) => {
    const selected = latest.current;
    const state = current.current;
    if (!selected.draftId || state.pending || state.storageError || !state.saved?.review) return;
    let saved = structuredClone(state.saved);
    if (!saved.submission) {
      if (
        retry ||
        !equal(saved.intent, selected.intent) ||
        !sameSettings(saved.review!.settings, selected.settings)
      )
        return;
      saved.submission = TelosWorkRoleSetupInputSchema.parse({
        itemId: saved.intent.itemId,
        role: saved.intent.role,
        requestId: createBrowserId(),
        expectedRevision: saved.review!.context.brief.revision,
        expectedAssignmentRevision: saved.review!.expectedAssignmentRevision,
        settings: saved.review!.settings,
        contextSelection: saved.review!.context,
      });
    }
    try {
      persist(saved);
    } catch {
      update({
        ...state,
        error: 'The original role request could not be saved. Setup has not been sent.',
        storageError: true,
      });
      return;
    }
    const operation = ++generation.current;
    const draftId = selected.draftId;
    update({ ...state, saved, pending: 'setup', error: null });
    try {
      const receipt = TelosWorkCommandReceiptSchema.parse(
        await selected.api.setupRole(structuredClone(saved.submission!)),
      );
      if (!active(operation, draftId)) return;
      const conversationId = boundConversation(receipt, saved);
      saved = { ...saved, receipt };
      persist(saved);
      update({ saved, pending: null, error: null, uncertain: false, storageError: false });
      latest.current.onBound?.(conversationId);
    } catch (error) {
      if (!active(operation, draftId)) return;
      const recovery = TelosWorkRoleSetupRecoverySchema.safeParse(
        error instanceof TelosWorkApiError ? error.recovery : undefined,
      );
      if (
        error instanceof TelosWorkApiError &&
        error.status === 409 &&
        error.code === 'conflict' &&
        recovery.success &&
        recovery.data.outcome === 'rejected_before_allocation' &&
        recovery.data.requestId === saved.submission!.requestId
      ) {
        const rejected: Saved = {
          ...saved,
          submission: null,
          review: null,
          receipt: null,
          rejections: [
            ...saved.rejections,
            { submission: saved.submission!, recovery: recovery.data },
          ],
        };
        try {
          // The history and release share a verified write. Never release in
          // memory first or overwrite a newer request saved by another tab.
          persist(rejected, saved.submission!);
          update({
            saved: rejected,
            pending: null,
            uncertain: false,
            storageError: false,
            error: rejectedMessage,
          });
        } catch {
          update({
            ...current.current,
            pending: null,
            uncertain: true,
            storageError: true,
            error:
              'The rejection could not be saved in device storage. Keep this draft to preserve its original request.',
          });
        }
      } else
        update({
          ...current.current,
          pending: null,
          uncertain: true,
          error: 'Setup could not be confirmed. Retry to recover the same request.',
        });
    }
  };
  let boundConversationId: string | null = null;
  if (state.saved?.receipt) {
    try {
      boundConversationId = boundConversation(state.saved.receipt, state.saved);
    } catch {
      /* Preserve the original request for explicit recovery. */
    }
  }
  return {
    context: state.saved?.review?.context ?? null,
    pending: state.pending,
    error: state.error,
    uncertain: state.uncertain,
    rejectedBeforeAllocation:
      !!state.saved?.rejections.length && !state.saved.review && !state.saved.submission,
    locked: state.storageError || state.saved?.submission != null,
    canConfirm:
      !state.pending &&
      !state.storageError &&
      !state.saved?.submission &&
      state.saved?.review != null &&
      equal(state.saved.intent, options.intent) &&
      sameSettings(state.saved.review.settings, options.settings),
    boundConversationId,
    replacing:
      state.saved?.intent.mode === 'assign' &&
      (state.saved.review?.expectedAssignmentRevision ?? 0) > 0,
    review,
    confirm: () => submit(false),
    retry: () => (current.current.saved?.submission ? submit(true) : review()),
  };
}
