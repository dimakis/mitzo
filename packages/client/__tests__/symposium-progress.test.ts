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
    progressId: 'progress-reviewer',
    messageId: 'b0',
    sourceToolId: 'todo',
    symposiumProvenance: reviewer,
    items: [{ id: 'r', title: 'Review', status: 'in_progress' }],
  });
  expect(state.toolIndex[progressToolLookupKey('b0', 'todo', architect)]).toBe(
    'progress-architect',
  );
  expect(state.toolIndex[progressToolLookupKey('b0', 'todo', reviewer)]).toBe('progress-reviewer');
  expect(state.toolIndex.todo).toBeUndefined();
});
