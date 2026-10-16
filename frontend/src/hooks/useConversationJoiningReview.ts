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
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function sourcePins(review: ConversationJoiningReviewResult) {
  const { sourceConversationId, boundary, mode, purpose, messages, artifacts, summary } =
    review.snapshot;
  return { sourceConversationId, boundary, mode, purpose, messages, artifacts, summary };
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
  previous?: ConversationJoiningReviewResult,
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
      (!equal(sourcePins(review), sourcePins(previous)) ||
        !equal(settings, previous.settings) ||
        review.expectedMembershipRevision !== previous.expectedMembershipRevision ||
        (brief !== previous.snapshot.joiningBrief &&
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

/** Local state fences presentation; authoritative source, capacity, allocation and
 * operation receipts remain with the supplied ordinary application owner. */
export function useConversationJoiningReview(
  owner?: ConversationJoiningOwner,
  onLinked?: (join: CollaborationJoin) => void,
) {
  const [state, setState] = useState<State>(initial);
  const current = useRef(state);
  const generation = useRef(0);
  const read = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const boundSource = useRef<string | null>(owner?.sourceConversationId ?? null);
  const lastReview = useRef<{
    input: Parameters<ConversationJoiningOwner['review']>[0];
    previous?: ConversationJoiningReviewResult;
  } | null>(null);
  const update = (change: Partial<State>) => {
    current.current = { ...current.current, ...change };
    setState(current.current);
  };
  useEffect(() => {
    const sequence = generation;
    alive.current = true;
    return () => {
      alive.current = false;
      sequence.current++;
      read.current?.abort();
    };
  }, []);
  const ownerAvailable =
    !!owner && (boundSource.current === null || boundSource.current === owner.sourceConversationId);
  const review = async (
    setup: ConversationAgentSetup,
    brief?: string,
    previous?: ConversationJoiningReviewResult,
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
      const result = await owner.review(structuredClone(input), controller.signal);
      if (!alive.current || generation.current !== operation) return;
      const accepted = readReview(result, owner, captured, brief, previous);
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
    update({ submission: structuredClone(input), pending: 'confirm', error: null });
    const operation = ++generation.current;
    try {
      const result = await owner.confirm(input);
      if (!alive.current || generation.current !== operation) return;
      const accepted = readJoin(result, current.current.submission!);
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
    const operation = ++generation.current;
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    update({ pending: 'recover', error: null });
    try {
      const result = await owner.recover(state.join.joinId, controller.signal);
      if (!alive.current || generation.current !== operation) return;
      const accepted = readJoin(result, state.submission, state.join);
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
    locked: state.submission !== null,
    prepare: (setup: ConversationAgentSetup) => review(setup),
    editBrief: (brief: string) => {
      const state = current.current;
      if (!state.setup || !state.review || state.submission) return Promise.resolve();
      return review(state.setup, brief, state.review);
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
      if (current.current.join?.state !== 'linked' || current.current.pending) return false;
      generation.current++;
      read.current?.abort();
      current.current = initial();
      lastReview.current = null;
      setState(current.current);
      return true;
    },
  };
}
