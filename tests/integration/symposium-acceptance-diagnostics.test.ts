import { expect, it, vi } from 'vitest';
import { EventStore } from '../../server/event-store.js';
import { observeAcceptanceCommand } from '../support/symposium-acceptance-diagnostics.js';

it('projects actual command observations without serializing private receipt/session fields', () => {
  const store = new EventStore(':memory:');
  try {
    store.upsertSession({ sessionId: 'recipient', cwd: '/PRIVATE_SENTINEL' });
    vi.spyOn(store, 'getSendCommand').mockReturnValue({
      clientMsgId: 'original-command',
      sessionId: 'recipient',
      payload: { text: 'PRIVATE_SENTINEL' },
      error: 'PRIVATE_SENTINEL',
    });
    const observation = observeAcceptanceCommand(store, 'recipient', 'original-command');
    expect(observation.send).toEqual({
      status: 'observed',
      value: {
        exists: true,
        clientMsgId: 'original-command',
        sessionId: 'recipient',
        hasError: true,
      },
    });
    expect(observation.session.status).toBe('observed');
    expect(JSON.stringify(observation)).not.toContain('PRIVATE_SENTINEL');
  } finally {
    vi.restoreAllMocks();
    store.close();
  }
});

it('keeps independent observations when a getter rejects, without exposing its private cause', () => {
  const store = new EventStore(':memory:');
  try {
    vi.spyOn(store, 'getSendCommand').mockImplementation(() => {
      throw new Error('PRIVATE_SENTINEL', { cause: new Error('PRIVATE_CAUSE') });
    });
    vi.spyOn(store, 'getOrdinaryCommandExecutionAdmission').mockImplementation(() => {
      throw new Error('PRIVATE_ADMISSION');
    });
    vi.spyOn(store, 'getCurrentExecutionCommandId').mockReturnValue('original-command');
    const observation = observeAcceptanceCommand(store, 'recipient', 'original-command');
    expect(observation.send).toEqual({
      status: 'unavailable',
      code: 'acceptance_observation_unavailable',
      observation: 'send_command',
    });
    expect(observation.admission.status).toBe('unavailable');
    expect(observation.currentCommand).toEqual({ status: 'observed', value: 'original-command' });
    expect(observation.session).toEqual({ status: 'observed', value: null });
    expect(JSON.stringify(observation)).not.toContain('PRIVATE_');
  } finally {
    vi.restoreAllMocks();
    store.close();
  }
});
