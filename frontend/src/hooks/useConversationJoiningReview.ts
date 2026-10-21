import { useCallback, useEffect, useRef, useState } from 'react';
import { createBrowserId } from '../lib/browser-crypto';
import {
  CollaborationApplicationReviewInputSchema,
  CollaborationApplicationReviewResultSchema,
  CollaborationJoinInputSchema,
  CollaborationJoinSchema,
  type CollaborationJoin,
  type CollaborationJoinInput,
} from '@mitzo/protocol';
import type {
  ConversationAgentSetup,
  ConversationJoiningOwner,
  ConversationJoiningReviewRequest,
  ConversationJoiningReviewResult,
} from '../lib/conversation-joining-review';
import {
  conversationJoiningRecovery,
  joiningReviewEqual as equal,
  joiningReviewFence,
  type ConversationJoiningRecoveryRecord,
  type ConversationJoiningReviewFence,
} from '../lib/conversation-joining-recovery';
import {
  AUTH_LOST_EVENT,
  AUTH_RESTORED_EVENT,
  currentVerifiedAuthSessionId,
} from '../lib/api-fetch';
import {
  conversationArtifactKey,
  sameConversationArtifact,
} from '../lib/conversation-joining-artifacts';
import { ConversationJoiningTargetError } from '../lib/conversation-joining-target-intent';

type State = {
  review: ConversationJoiningReviewResult | null;
  setup: ConversationAgentSetup | null;
  restoredSetup: ConversationAgentSetup | null;
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
  restoredSetup: null,
  brief: '',
  pending: null,
  error: null,
  submission: null,
  uncertain: false,
  join: null,
});
const recoveryError =
  'The original joining request could not be retained. Check again before joining.';
const applicationRecoveryError =
  'The original application review was not retained. This joining request cannot be checked here.';
function restoredState(record: ConversationJoiningRecoveryRecord | null): State {
  if (!record) return initial();
  return {
    ...initial(),
    setup: structuredClone(record.reviewRequest.setup),
    restoredSetup: structuredClone(record.reviewRequest.setup),
    brief:
      record.reviewRequest.joiningBrief ??
      record.acceptedReview?.joiningBrief ??
      (record.version === 2 && record.application.state === 'captured'
        ? record.application.input.selection.joiningBrief
        : ''),
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
const repositoryCurrent = (owner: ConversationJoiningOwner, setup: ConversationAgentSetup | null) =>
  owner.kind !== 'application' ||
  setup?.sourceRepository === undefined ||
  owner.sourceRepository === setup.sourceRepository;
function readReview(
  raw: ConversationJoiningReviewResult,
  owner: ConversationJoiningOwner,
  setup: ConversationAgentSetup,
  brief?: string,
  previous?: ConversationJoiningReviewFence,
): ConversationJoiningReviewResult {
  const review = CollaborationApplicationReviewResultSchema.parse(raw);
  const { snapshot, settings } = review;
  const selectedArtifacts = setup.artifacts.map(conversationArtifactKey).sort();
  const frozenArtifacts = snapshot.artifacts.map(conversationArtifactKey).sort();
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
    (setup.context === 'selected'
      ? new Set(selectedArtifacts).size !== selectedArtifacts.length ||
        new Set(frozenArtifacts).size !== frozenArtifacts.length ||
        !equal(frozenArtifacts, selectedArtifacts)
      : setup.artifacts.some(
          (a) => !snapshot.artifacts.some((pin) => sameConversationArtifact(a, pin)),
        )) ||
    snapshot.artifacts.some((pin) => {
      const labels = review.artifactLabels?.filter((label) => sameConversationArtifact(label, pin));
      return (
        labels?.length !== 1 ||
        ('kind' in pin && (labels[0].title !== pin.title || labels[0].filename !== pin.filename))
      );
    }) ||
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
        (previous.state === 'linked' &&
          (join.state !== 'linked' || join.linkedFromRevision !== previous.linkedFromRevision)) ||
        (previous.state === 'allocated' && join.state === 'pending_preparation')))
  )
    throw new Error('Joining receipt changed');
  return join;
}

function ownerIdentity(owner?: ConversationJoiningOwner) {
  return owner
    ? JSON.stringify([
        owner.sourceConversationId,
        owner.kind ?? 'legacy',
        owner.kind === 'application' ? owner.collaborationId : null,
      ])
    : null;
}
function acceptsRecord(
  owner: ConversationJoiningOwner,
  record: ConversationJoiningRecoveryRecord | null,
) {
  return (
    !record ||
    record.version === 1 ||
    (owner.kind === 'application' && record.application.collaborationId === owner.collaborationId)
  );
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
  const loginInvalidated = useRef(false);
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const [state, setState] = useState<State>(() => {
    if (owner) {
      try {
        if (currentVerifiedAuthSessionId()) {
          journal.current = conversationJoiningRecovery(owner.sourceConversationId);
          retained.current = journal.current.read();
        }
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
  const boundOwner = useRef(ownerIdentity(owner));
  const previousOwner = useRef(ownerIdentity(owner));
  // A persisted linked receipt is correlation, not fresh server authorization.
  const restored = useRef(retained.current !== null);
  const lastReview = useRef<{
    input: ConversationJoiningReviewRequest;
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
  const adoptJournal = useCallback(() => {
    const available = currentOwner.current;
    if (
      !alive.current ||
      !available ||
      journal.current ||
      storageBlocked.current ||
      loginInvalidated.current ||
      (boundSource.current !== null && boundSource.current !== available.sourceConversationId)
    )
      return;
    try {
      if (!currentVerifiedAuthSessionId()) return;
      const selected = conversationJoiningRecovery(available.sourceConversationId);
      const record = selected.read();
      journal.current = selected;
      retained.current = record;
      boundSource.current = available.sourceConversationId;
      boundOwner.current ??= ownerIdentity(available);
      if (record) {
        restored.current = true;
        lastReview.current = {
          input: structuredClone(record.reviewRequest),
          previous: record.previousReview,
        };
        current.current = restoredState(record);
      } else current.current = { ...current.current };
    } catch {
      storageBlocked.current = true;
      current.current = { ...current.current, error: recoveryError };
    }
    setState(current.current);
  }, []);
  useEffect(() => {
    const sequence = generation;
    alive.current = true;
    const invalidate = () => {
      if (!journal.current) {
        // Existing auth restoration dispatches before assigning its final verified
        // identity. One local microtask can adopt it; there is no polling or I/O.
        queueMicrotask(adoptJournal);
        return;
      }
      if (journal.current.isCurrent()) return;
      sequence.current++;
      read.current?.abort();
      loginInvalidated.current = true;
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
  }, [adoptJournal]);
  const selectedOwner = ownerIdentity(owner);
  useEffect(() => {
    if (previousOwner.current !== selectedOwner) {
      previousOwner.current = selectedOwner;
      generation.current++;
      read.current?.abort();
      if (lastReview.current) {
        restored.current = current.current.join !== null;
        current.current = {
          ...current.current,
          pending: null,
          uncertain: !!current.current.submission && !current.current.join,
          error: 'Joining could not be checked. The original request is retained.',
        };
        setState(current.current);
      }
    }
    adoptJournal();
  }, [selectedOwner, adoptJournal]);
  const ownerAvailable =
    !!owner &&
    boundOwner.current === ownerIdentity(owner) &&
    acceptsRecord(owner, retained.current) &&
    (boundSource.current === null || boundSource.current === owner.sourceConversationId) &&
    !storageBlocked.current &&
    !loginInvalidated.current &&
    !!journal.current?.isCurrent();
  const canPublish = (operation: number, identity: string) =>
    alive.current &&
    generation.current === operation &&
    ownerIdentity(currentOwner.current) === identity &&
    boundOwner.current === identity &&
    !!currentOwner.current &&
    acceptsRecord(currentOwner.current, retained.current) &&
    !storageBlocked.current &&
    !loginInvalidated.current &&
    !!journal.current?.isCurrent();
  const ensureRecovery = () => {
    if (
      !currentOwner.current ||
      currentOwner.current.sourceConversationId !== boundSource.current ||
      ownerIdentity(currentOwner.current) !== boundOwner.current ||
      !acceptsRecord(currentOwner.current, retained.current) ||
      storageBlocked.current ||
      loginInvalidated.current ||
      !journal.current?.isCurrent()
    )
      throw new Error('Joining owner unavailable');
    return journal.current;
  };
  const save = (record: ConversationJoiningRecoveryRecord) => {
    retained.current = ensureRecovery().save(record, retained.current);
  };
  const review = async (
    setup: ConversationAgentSetup,
    brief?: string,
    previous?: ConversationJoiningReviewFence,
    retryInput?: ConversationJoiningReviewRequest,
    freshApplication = false,
  ) => {
    if (!owner || !ownerAvailable || current.current.submission) return;
    const identity = ownerIdentity(owner)!;
    if (owner.kind === 'application' && retained.current?.version === 1 && !freshApplication) {
      update({
        error:
          'The original application review cannot be reconstructed. Start an explicit fresh review.',
      });
      return;
    }
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
          ...(previous && owner.kind === 'application' && current.current.review
            ? {
                previousSource: {
                  boundary: structuredClone(current.current.review.snapshot.boundary),
                  expectedMembershipRevision: previous.expectedMembershipRevision,
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
      const existing = retained.current;
      if (owner.kind === 'application') {
        if (!(
          retryInput &&
          existing?.version === 2 &&
          existing.reviewRequest.requestId === input.requestId
        ))
          save({
            version: 2,
            sourceConversationId: owner.sourceConversationId,
            reviewRequest: input,
            ...(previous ? { previousReview: previous } : {}),
            application: { state: 'capture_pending', collaborationId: owner.collaborationId },
          });
        else if (!equal(ensureRecovery().read(), existing))
          throw new Error('Joining recovery operation changed');
      } else {
        save({
          version: 1,
          sourceConversationId: owner.sourceConversationId,
          reviewRequest: input,
          ...(previous ? { previousReview: previous } : {}),
        });
      }
    } catch {
      // A pending ordinary preparation can refuse a changed draft. Retrying
      // must still recover its original stored review, never the rejected ID.
      if (retained.current)
        lastReview.current = {
          input: structuredClone(retained.current.reviewRequest),
          previous: retained.current.previousReview,
        };
      update({
        setup: captured,
        ...(brief !== undefined ? { brief } : {}),
        pending: null,
        error: recoveryError,
      });
      return;
    }
    try {
      let result: ConversationJoiningReviewResult;
      if (owner.kind === 'application') {
        if (retained.current?.version !== 2) throw new Error('Application intent unavailable');
        if (retained.current.application.state === 'capture_pending') {
          if (owner.prepareReview)
            await owner.prepareReview(structuredClone(input), controller.signal);
          if (!canPublish(operation, identity)) return;
          const raw = await owner.captureReview(structuredClone(input), controller.signal);
          if (!canPublish(operation, identity)) return;
          const normalized = CollaborationApplicationReviewInputSchema.parse(raw);
          save({
            ...retained.current,
            application: {
              state: 'captured',
              collaborationId: owner.collaborationId,
              input: normalized,
            },
          });
          update({ brief: normalized.selection.joiningBrief });
        }
        // The journal has parsed and independently cloned the exact public DTO.
        // Never re-read source or settings once a POST may have crossed the wire.
        const record = retained.current;
        if (record?.version !== 2 || record.application.state !== 'captured')
          throw new Error('Captured application intent unavailable');
        const applicationInput = structuredClone(record.application.input);
        result = await owner.review(structuredClone(applicationInput), controller.signal);
        if (!canPublish(operation, identity)) return;
        const { snapshot, settings } = result;
        if (
          !equal(snapshot.boundary, applicationInput.selection.boundary) ||
          result.expectedMembershipRevision !==
            applicationInput.selection.expectedMembershipRevision ||
          snapshot.joiningBrief !== applicationInput.selection.joiningBrief ||
          settings.repositoryWorkspaceId !== applicationInput.target.repositoryWorkspaceId ||
          settings.selection.permission.mode !== applicationInput.target.permissionMode
        )
          throw new Error('Application review changed');
      } else {
        result = await owner.review(structuredClone(input), controller.signal);
      }
      if (!canPublish(operation, identity)) return;
      const accepted = readReview(result, owner, captured, brief, previous);
      save({ ...retained.current!, acceptedReview: joiningReviewFence(accepted) });
      update({ review: accepted, brief: accepted.snapshot.joiningBrief, pending: null });
    } catch (cause) {
      if (!canPublish(operation, identity)) return;
      update({
        pending: null,
        error:
          cause instanceof ConversationJoiningTargetError
            ? cause.message
            : 'The joining brief could not be checked. Your setup and edits stay here.',
      });
    }
  };
  const confirm = async () => {
    const state = current.current;
    if (!owner || !ownerAvailable || state.pending || state.join) return;
    if (owner.kind === 'application' && retained.current?.version !== 2) {
      update({ error: applicationRecoveryError });
      return;
    }
    const identity = ownerIdentity(owner)!;
    let input = state.submission;
    if (!input) {
      if (!ready(state) || !state.review || !state.setup || !repositoryCurrent(owner, state.setup))
        return;
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
      if (!canPublish(operation, identity)) return;
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
      if (!canPublish(operation, identity)) return;
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
    if (owner.kind === 'application' && retained.current?.version !== 2) {
      update({ error: applicationRecoveryError });
      return;
    }
    const identity = ownerIdentity(owner)!;
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
      if (!canPublish(operation, identity)) return;
      const accepted = readJoin(result, state.submission, state.join);
      save({ ...retained.current!, join: accepted });
      restored.current = false;
      update({ join: accepted, pending: null });
      if (accepted.state === 'linked') onLinked?.(accepted);
    } catch {
      if (!canPublish(operation, identity)) return;
      update({
        pending: null,
        error: 'Joining could not be checked. The original request is retained.',
      });
    }
  };
  return {
    ...state,
    review: ownerAvailable ? state.review : null,
    requiresRecovery: restored.current && state.join !== null,
    canConfirm: ownerAvailable && !!owner && repositoryCurrent(owner, state.setup) && ready(state),
    locked:
      state.submission !== null ||
      storageBlocked.current ||
      loginInvalidated.current ||
      (!!owner && !journal.current),
    hasAttemptFor: (setup: ConversationAgentSetup) =>
      current.current.setup !== null && equal(current.current.setup, setup),
    prepare: (setup: ConversationAgentSetup, initialBrief?: string) => {
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
      // Initial application intent needs explicit editable brief bytes. A resumed
      // attempt above always retains its original request, including empty edits.
      return review(setup, initialBrief);
    },
    prepareFreshReview: (setup: ConversationAgentSetup) => {
      const state = current.current;
      if (
        owner?.kind !== 'application' ||
        !ownerAvailable ||
        retained.current?.version !== 1 ||
        state.pending ||
        state.submission ||
        state.join
      )
        return Promise.resolve();
      return review(setup, state.brief, undefined, undefined, true);
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
