import { expect, it } from 'vitest';
import {
  INITIAL_PROGRESS_STATE,
  applyProgressUpdate,
  progressToolLookupKey,
} from '../src/slices/progress.js';

it('keeps reused message and tool IDs separate for concurrent Symposium seats', () => {
  const provenance = (seatId: string) => ({
    seatId,
    configRevision: 1,
    accountProfileRevision: 'a',
    seatProfileRevision: 'p',
    contextGrantRevision: 1,
    authorityGrantRevision: 1,
    isolationDomainId: 'shared',
    isolationDomainRevision: 1,
    membershipGeneration: 2,
  });
  const architect = provenance('architect');
  const reviewer = provenance('reviewer');
  let state = applyProgressUpdate(INITIAL_PROGRESS_STATE, {
    type: 'start',
    progressId: 'progress-architect',
    messageId: 'b0',
    sourceToolId: 'todo',
    symposiumProvenance: architect,
    items: [{ id: 'a', title: 'Design', status: 'in_progress' }],
  });
  state = applyProgressUpdate(state, {
    type: 'start',
    progressId: 'same-progress',
    messageId: 'b0',
    sourceToolId: 'todo',
    symposiumProvenance: reviewer,
    items: [{ id: 'r', title: 'Review', status: 'in_progress' }],
  });
  expect(state.toolIndex[progressToolLookupKey('b0', 'todo', architect)]).toBe(
    'symposium:["architect",2,"progress-architect"]',
  );
  expect(state.toolIndex[progressToolLookupKey('b0', 'todo', reviewer)]).toBe(
    'symposium:["reviewer",2,"same-progress"]',
  );
  expect(state.toolIndex.todo).toBeUndefined();
});

it('keeps colliding progress IDs and subsequent updates scoped to each seat', () => {
  const provenance = (seatId: string) => ({
    seatId,
    membershipGeneration: 2,
    configRevision: 1,
    accountProfileRevision: 'a',
    seatProfileRevision: 'p',
    contextGrantRevision: 1,
    authorityGrantRevision: 1,
    isolationDomainId: 'shared',
    isolationDomainRevision: 1,
  });
  const architect = provenance('architect');
  const reviewer = provenance('reviewer');
  let state = INITIAL_PROGRESS_STATE;
  for (const seat of [architect, reviewer])
    state = applyProgressUpdate(state, {
      type: 'start',
      progressId: 'same-progress',
      messageId: 'same-message',
      sourceToolId: 'same-tool',
      symposiumProvenance: seat,
      items: [{ id: 'task', title: seat.seatId, status: 'pending' }],
    });
  const architectKey =
    state.toolIndex[progressToolLookupKey('same-message', 'same-tool', architect)];
  const reviewerKey = state.toolIndex[progressToolLookupKey('same-message', 'same-tool', reviewer)];
  expect(architectKey).not.toBe(reviewerKey);
  expect(state.blocks[architectKey].items[0].title).toBe('architect');
  expect(state.blocks[reviewerKey].items[0].title).toBe('reviewer');

  const ambiguous = applyProgressUpdate(state, {
    type: 'update',
    progressId: 'same-progress',
    itemId: 'task',
    status: 'done',
  });
  expect(ambiguous).toBe(state);
  state = applyProgressUpdate(state, {
    type: 'update',
    progressId: 'same-progress',
    symposiumProvenance: reviewer,
    itemId: 'task',
    status: 'done',
  });
  expect(state.blocks[architectKey].items[0].status).toBe('pending');
  expect(state.blocks[reviewerKey].items[0].status).toBe('done');
  state = applyProgressUpdate(state, {
    type: 'replace',
    progressId: 'same-progress',
    symposiumProvenance: reviewer,
    sourceToolId: 'new-tool',
    items: [{ id: 'replacement', title: 'Reviewer only', status: 'in_progress' }],
  });
  expect(state.blocks[architectKey].items[0].title).toBe('architect');
  expect(state.blocks[reviewerKey].items[0].title).toBe('Reviewer only');
  expect(state.toolIndex[progressToolLookupKey('same-message', 'new-tool', reviewer)]).toBe(
    reviewerKey,
  );
});
