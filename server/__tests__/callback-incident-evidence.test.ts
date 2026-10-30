import { expect, it } from 'vitest';
import { inspectCallbackIncidentRollout, callbackIncident } from '../callback-incident-evidence.js';
const line = (type: string, payload: object) => JSON.stringify({ type, payload });
const fixture = () =>
  [
    line('session_meta', { id: callbackIncident.threadId, cli_version: '0.160.0' }),
    line('event_msg', { type: 'task_started', turn_id: callbackIncident.turnId }),
    line('event_msg', { type: 'task_complete', turn_id: callbackIncident.turnId }),
  ].join('\n') + '\n';
it('accepts only the original terminal native turn, without projecting conversation text', () => {
  expect(inspectCallbackIncidentRollout(fixture())).toEqual({
    threadId: callbackIncident.threadId,
    turnId: callbackIncident.turnId,
    status: 'completed',
  });
});
it.each([
  () => fixture().replace(callbackIncident.threadId, 'other'),
  () => fixture().replace('0.160.0', 'unknown'),
  () => fixture().replace('task_complete', 'task_failed'),
  () => fixture() + line('event_msg', { type: 'task_started', turn_id: 'newer' }) + '\n',
  () =>
    fixture() +
    line('event_msg', { type: 'task_complete', turn_id: callbackIncident.turnId }) +
    '\n',
  () => fixture() + '{partial',
])('refuses changed, conflicting, newer or incomplete native evidence', (changed) => {
  expect(() => inspectCallbackIncidentRollout(changed())).toThrow();
});
