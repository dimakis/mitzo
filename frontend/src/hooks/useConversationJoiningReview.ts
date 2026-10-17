import { useEffect, useRef, useState } from 'react';
import { createBrowserId } from '../lib/browser-crypto';
import {
  CollaborationJoinInputSchema,
  CollaborationJoinSchema,
  CollaborationSettingsSchema,
  CollaborationSnapshotSchema,
  type CollaborationJoin,
  type CollaborationJoinInput,
} from '@mitzo/protocol';
import type {
  ConversationAgentSetup,
  ConversationJoiningOwner,
  ConversationJoiningReviewResult,
} from '../lib/conversation-joining-review';
import {
  conversationJoiningRecovery,
  joiningReviewEqual as equal,
  joiningReviewFence,
  type ConversationJoiningRecoveryRecord,
  type ConversationJoiningReviewFence,
} from '../lib/conversation-joining-recovery';
import { AUTH_LOST_EVENT, AUTH_RESTORED_EVENT } from '../lib/api-fetch';

type State = {
  review: ConversationJoiningReviewResult | null;
  setup: ConversationAgentSetup | null;
  brief: string;
  pending: 'review' | 'confirm' | 'recover' | null;
  error: string | null;
  submission: CollaborationJoinInput | null;
  uncertain: boolean;
  join: CollaborationJoin | null;
};
const initial = (): State => ({
  review: null,
  setup: null,
  brief: '',
  pending: null,
  error: null,
  submission: null,
  uncertain: false,
  join: null,
});
const recoveryError =
  'The original joining request could not be retained. Check again before joining.';
function restoredState(record: ConversationJoiningRecoveryRecord | null): State {
  if (!record) return initial();
  return {
    ...initial(),
    setup: structuredClone(record.reviewRequest.setup),
    brief: record.reviewRequest.joiningBrief ?? record.acceptedReview?.joiningBrief ?? '',
    submission: record.submission ? structuredClone(record.submission) : null,
    join: record.join ? structuredClone(record.join) : null,
    uncertain: !!record.submission && !record.join,
    error: record.submission ? null : 'Check the retained joining brief before confirming.',
  };
}
function ready(state: State) {
  if (!state.review || state.pending || state.submission || state.join || state.error) return false;
  const { snapshot, settings } = state.review;
  return (
    snapshot.joiningBrief === state.brief &&
    snapshot.capacity.status === 'ready' &&
    snapshot.capacity.assessments.some((a) => equal(a.settings, settings))
  );
}
function readReview(
  raw: ConversationJoiningReviewResult,
  owner: ConversationJoiningOwner,
  setup: ConversationAgentSetup,
  brief?: string,
  previous?: ConversationJoiningReviewFence,
): ConversationJoiningReviewResult {
  const review = {
    ...raw,
    snapshot: CollaborationSnapshotSchema.parse(raw.snapshot),
    settings: CollaborationSettingsSchema.parse(raw.settings),
  };
  const { snapshot, settings } = review;
  if (
    !Number.isSafeInteger(review.expectedMembershipRevision) ||
    review.expectedMembershipRevision < 0 ||
    snapshot.sourceConversationId !== owner.sourceConversationId ||
    snapshot.mode !== setup.context ||
    snapshot.purpose !== setup.purpose.trim() ||
    !setup.selection ||
    settings.binding.account.accountId !== setup.selection.accountId ||
    settings.selection.model !== setup.selection.model ||
    settings.selection.thinking !== (setup.selection.reasoningEffort ?? null) ||
    settings.binding.execution.location !== setup.runOn ||
    (setup.agent && !equal(settings.selection.agent, setup.agent)) ||
    (setup.context === 'selected' &&
      !equal(
        [...snapshot.messages.map((m) => m.messageId)].sort(),
        [...setup.messageIds].sort(),
      )) ||
    setup.artifacts.some(
      (a) =>
        !snapshot.artifacts.some(
          (pin) =>
            a.artifactId === pin.artifactId &&
            a.revision === pin.revision &&
            a.sha256 === pin.sha256,
        ),
    ) ||
    snapshot.artifacts.some(
      (pin) =>
        !review.artifactLabels?.some(
          (label) =>
            label.artifactId === pin.artifactId &&
            label.revision === pin.revision &&
            label.sha256 === pin.sha256 &&
            typeof label.title === 'string' &&
            label.title.trim().length > 0 &&
            label.title.length <= 1000 &&
            (label.filename === undefined ||
              (typeof label.filename === 'string' &&
                label.filename.trim().length > 0 &&
                label.filename.length <= 1000)),
        ),
    ) ||
    (brief !== undefined && snapshot.joiningBrief !== brief) ||
    (previous &&
      (joiningReviewFence(review).sourceSha256 !== previous.sourceSha256 ||
        !equal(settings, previous.settings) ||
        review.expectedMembershipRevision !== previous.expectedMembershipRevision ||
        (brief !== previous.joiningBrief &&
          (snapshot.snapshotId === previous.snapshot.snapshotId ||
            snapshot.sha256 === previous.snapshot.sha256))))
  )
    throw new Error('Review changed');
  return review;
}
function readJoin(
  raw: CollaborationJoin,
  input: CollaborationJoinInput,
  previous?: CollaborationJoin,
) {
  const join = CollaborationJoinSchema.parse(raw);
  if (
    join.name !== input.name ||
    join.membershipRevision !== input.expectedMembershipRevision ||
    !equal(join.settings, input.settings) ||
    !equal(join.snapshot, input.snapshot) ||
    (previous &&
      (join.joinId !== previous.joinId ||
        join.allocationOperationId !== previous.allocationOperationId ||
        (previous.sessionId !== null && join.sessionId !== previous.sessionId) ||
        (previous.state === 'linked' && join.state !== 'linked') ||
        (previous.state === 'allocated' && join.state === 'pending_preparation')))
  )
    throw new Error('Joining receipt changed');
  return join;
}

/** Local presentation and retry correlation only. Current source, capacity,
 * allocation and operation receipts remain with the authenticated ordinary owner. */
export function useConversationJoiningReview(
  owner?: ConversationJoiningOwner,
  onLinked?: (join: CollaborationJoin) => void,
) {
  const journal = useRef<ReturnType<typeof conversationJoiningRecovery> | null>(null);
  const retained = useRef<ConversationJoiningRecoveryRecord | null>(null);
  const storageBlocked = useRef(false);
  const [state, setState] = useState<State>(() => {
    if (owner) {
      try {
        journal.current = conversationJoiningRecovery(owner.sourceConversationId);
        retained.current = journal.current.read();
      } catch {
        storageBlocked.current = true;
      }
    }
    return {
      ...restoredState(retained.current),
      ...(storageBlocked.current ? { error: recoveryError } : {}),
    };
  });
  const current = useRef(state);
  const generation = useRef(0);
  const read = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const boundSource = useRef<string | null>(owner?.sourceConversationId ?? null);
  // A persisted linked receipt is correlation, not fresh server authorization.
  const restored = useRef(retained.current !== null);
  const lastReview = useRef<{
    input: Parameters<ConversationJoiningOwner['review']>[0];
    previous?: ConversationJoiningReviewFence;
  } | null>(
    retained.current
      ? {
          input: structuredClone(retained.current.reviewRequest),
          previous: retained.current.previousReview,
        }
      : null,
  );
  const update = (change: Partial<State>) => {
    current.current = { ...current.current, ...change };
    setState(current.current);
  };
  useEffect(() => {
    const sequence = generation;
    alive.current = true;
    const invalidate = () => {
      if (!journal.current || journal.current.isCurrent()) return;
      sequence.current++;
      read.current?.abort();
      storageBlocked.current = true;
      current.current = { ...initial(), error: recoveryError };
      setState(current.current);
    };
    window.addEventListener(AUTH_LOST_EVENT, invalidate);
    window.addEventListener(AUTH_RESTORED_EVENT, invalidate);
    return () => {
      alive.current = false;
      sequence.current++;
      read.current?.abort();
      window.removeEventListener(AUTH_LOST_EVENT, invalidate);
      window.removeEventListener(AUTH_RESTORED_EVENT, invalidate);
    };
  }, []);
  const ownerAvailable =
    !!owner &&
    (boundSource.current === null || boundSource.current === owner.sourceConversationId) &&
    !storageBlocked.current &&
    (!journal.current || journal.current.isCurrent());
  const ensureRecovery = () => {
    if (!owner || !ownerAvailable) throw new Error('Joining owner unavailable');
    if (!journal.current) {
      journal.current = conversationJoiningRecovery(owner.sourceConversationId);
      retained.current = journal.current.read();
      if (retained.current) {
        restored.current = true;
        lastReview.current = {
          input: retained.current.reviewRequest,
          previous: retained.current.previousReview,
        };
        update(restoredState(retained.current));
      }
    }
    return journal.current;
  };
  const save = (record: ConversationJoiningRecoveryRecord) => {
    retained.current = ensureRecovery().save(record, retained.current);
  };
  const review = async (
    setup: ConversationAgentSetup,
    brief?: string,
    previous?: ConversationJoiningReviewFence,
    retryInput?: Parameters<ConversationJoiningOwner['review']>[0],
  ) => {
    if (!owner || !ownerAvailable || current.current.submission) return;
    boundSource.current = owner.sourceConversationId;
    const captured = structuredClone(setup);
    const input = retryInput
      ? structuredClone(retryInput)
      : {
          requestId: createBrowserId(),
          setup: captured,
          ...(brief !== undefined ? { joiningBrief: brief } : {}),
          ...(previous
            ? {
                previousSnapshot: {
                  snapshotId: previous.snapshot.snapshotId,
                  sha256: previous.snapshot.sha256,
                },
              }
            : {}),
        };
    lastReview.current = {
      input: structuredClone(input),
      previous: previous ? structuredClone(previous) : undefined,
    };
    const operation = ++generation.current;
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    update({
      setup: captured,
      pending: 'review',
      error: null,
      ...(brief !== undefined ? { brief } : { review: null }),
    });
    try {
      save({
        version: 1,
        sourceConversationId: owner.sourceConversationId,
        reviewRequest: input,
        ...(previous ? { previousReview: previous } : {}),
      });
    } catch {
      update({
        setup: captured,
        ...(brief !== undefined ? { brief } : {}),
        pending: null,
        error: recoveryError,
      });
      return;
    }
    try {
      const result = await owner.review(structuredClone(input), controller.signal);
      if (!alive.current || generation.current !== operation) return;
      const accepted = readReview(result, owner, captured, brief, previous);
      save({ ...retained.current!, acceptedReview: joiningReviewFence(accepted) });
      update({ review: accepted, brief: accepted.snapshot.joiningBrief, pending: null });
    } catch {
      if (!alive.current || generation.current !== operation) return;
      update({
        pending: null,
        error: 'The joining brief could not be checked. Your setup and edits stay here.',
      });
    }
  };
  const confirm = async () => {
    const state = current.current;
    if (!owner || !ownerAvailable || state.pending || state.join) return;
    let input = state.submission;
    if (!input) {
      if (!ready(state) || !state.review || !state.setup) return;
      input = CollaborationJoinInputSchema.parse({
        requestId: createBrowserId(),
        expectedMembershipRevision: state.review.expectedMembershipRevision,
        name: state.setup.name.trim(),
        settings: state.review.settings,
        snapshot: {
          snapshotId: state.review.snapshot.snapshotId,
          sha256: state.review.snapshot.sha256,
        },
      });
    }
    // Retain an independent exact request before crossing the network boundary.
    input = structuredClone(input);
    try {
      save({ ...retained.current!, submission: input });
    } catch {
      update({ submission: input, pending: null, uncertain: true, error: recoveryError });
      return;
    }
    update({ submission: structuredClone(input), pending: 'confirm', error: null });
    const operation = ++generation.current;
    try {
      const result = await owner.confirm(input);
      if (!alive.current || generation.current !== operation) return;
      const accepted = readJoin(result, current.current.submission!);
      save({ ...retained.current!, join: accepted });
      restored.current = false;
      update({
        join: accepted,
        pending: null,
        uncertain: false,
      });
      if (accepted.state === 'linked') onLinked?.(accepted);
    } catch {
      if (!alive.current || generation.current !== operation) return;
      update({
        pending: null,
        uncertain: true,
        error: 'Joining could not be confirmed. Check again to recover the same request.',
      });
    }
  };
  const recover = async () => {
    const state = current.current;
    if (!owner || !ownerAvailable || !state.join || !state.submission || state.pending) return;
    try {
      if (!equal(ensureRecovery().read(), retained.current))
        throw new Error('Joining recovery operation changed');
    } catch {
      update({ error: recoveryError });
      return;
    }
    const operation = ++generation.current;
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    update({ pending: 'recover', error: null });
    try {
      const result = await owner.recover(state.join.joinId, controller.signal);
      if (!alive.current || generation.current !== operation) return;
      const accepted = readJoin(result, state.submission, state.join);
      save({ ...retained.current!, join: accepted });
      restored.current = false;
      update({ join: accepted, pending: null });
      if (accepted.state === 'linked') onLinked?.(accepted);
    } catch {
      if (!alive.current || generation.current !== operation) return;
      update({
        pending: null,
        error: 'Joining could not be checked. The original request is retained.',
      });
    }
  };
  return {
    ...state,
    canConfirm: ownerAvailable && ready(state),
    locked: state.submission !== null || storageBlocked.current,
    hasAttemptFor: (setup: ConversationAgentSetup) =>
      current.current.setup !== null && equal(current.current.setup, setup),
    prepare: (setup: ConversationAgentSetup) => {
      if (!ownerAvailable) return Promise.resolve();
      try {
        ensureRecovery();
      } catch {
        storageBlocked.current = true;
        update({ error: recoveryError });
        return Promise.resolve();
      }
      const saved = lastReview.current;
      const state = current.current;
      // Back/Review resumes the operator's existing brief and exact source pins.
      // A lost response replays its complete receipt instead of creating a new intent.
      if (saved && equal(saved.input.setup, setup)) {
        return state.error && !state.pending
          ? review(saved.input.setup, saved.input.joiningBrief, saved.previous, saved.input)
          : Promise.resolve();
      }
      return review(setup);
    },
    editBrief: (brief: string) => {
      const state = current.current;
      if (!state.setup || !state.review || state.submission) return Promise.resolve();
      return review(state.setup, brief, joiningReviewFence(state.review));
    },
    retryReview: () => {
      const saved = lastReview.current;
      return saved
        ? review(saved.input.setup, saved.input.joiningBrief, saved.previous, saved.input)
        : Promise.resolve();
    },
    confirm,
    recover,
    startNew: () => {
      if (
        current.current.join?.state !== 'linked' ||
        current.current.pending ||
        restored.current ||
        !ownerAvailable
      )
        return false;
      try {
        ensureRecovery().clear(retained.current!);
      } catch {
        update({ error: recoveryError });
        return false;
      }
      generation.current++;
      read.current?.abort();
      current.current = initial();
      lastReview.current = null;
      retained.current = null;
      setState(current.current);
      return true;
    },
  };
}
