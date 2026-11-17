import { expect, it } from 'vitest';
import { CollaborationContractError, STEERED_TURN_UNSUPPORTED } from '@mitzo/protocol';
import { TranscriptReadFailure } from '../transcript-read-failure.js';

it('reports a steered-turn refusal as its own history failure reason', () => {
  const failure = new TranscriptReadFailure(
    new CollaborationContractError('snapshot_changed', STEERED_TURN_UNSUPPORTED),
    'durable',
  );
  expect(failure.telemetry().reason).toBe('steered_turn_unsupported');
});

it('separates other transcript contract refusals from unknown read failures', () => {
  expect(
    new TranscriptReadFailure(
      new CollaborationContractError('snapshot_changed'),
      'durable',
    ).telemetry().reason,
  ).toBe('transcript_contract_snapshot_changed');
  expect(new TranscriptReadFailure(Error('disk'), 'durable').telemetry().reason).toBe(
    'history_read_failed',
  );
});
