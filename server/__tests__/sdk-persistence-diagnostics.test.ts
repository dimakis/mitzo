import { expect, it } from 'vitest';
import {
  retainSdkPersistenceFailure,
  sdkPersistenceDiagnostic,
  sdkPersistenceFailure,
} from '../sdk-persistence-diagnostics.js';

const uuid = 'e6bd8754-8fc1-42e3-a580-ad9027af6066';
const loss = {
  type: 'system',
  subtype: 'session_writes_lost',
  session_id: 'original',
  uuid,
  error_code: 'ENOSPC',
  lost: ['transcript'],
  transcript_session_ids: ['original'],
};

it.each([
  ['session_writes_lost', loss, 'native transcript'],
  [
    'mirror_error',
    {
      type: 'system',
      subtype: 'mirror_error',
      session_id: 'original',
      uuid,
      error: 'PRIVATE_PAYLOAD',
      key: { projectKey: '/PRIVATE_PROJECT', sessionId: 'original' },
    },
    'mirror',
  ],
])('projects a sanitized %s notice without changing the completed result', (_name, event, text) => {
  const notice = sdkPersistenceDiagnostic(event as Record<string, unknown>, 'original');
  expect(notice).toMatchObject({
    nonfatal: true,
    correlationId: uuid,
    stage: 'native_persistence',
  });
  expect(notice?.error).toContain(text);
  expect(JSON.stringify(notice)).not.toContain('PRIVATE');
});

it.each([
  { ...loss, session_id: 'foreign' },
  { ...loss, session_id: undefined },
  { ...loss, type: 'assistant' },
  { ...loss, subtype: 'status' },
  { ...loss, parent_tool_use_id: 'child-tool' },
  {
    type: 'system',
    subtype: 'mirror_error',
    session_id: 'original',
    key: { sessionId: 'foreign' },
  },
  { type: 'system', subtype: 'mirror_error', session_id: 'original' },
])('rejects a foreign, child or unsupported diagnostic %#', (event) => {
  expect(sdkPersistenceDiagnostic(event, 'original')).toBeUndefined();
});

it.each([undefined, 'PRIVATE_NON_UUID', 'x'.repeat(4096)])(
  'replaces malformed correlation identity rather than exposing it',
  (value) => {
    const notice = sdkPersistenceDiagnostic({ ...loss, uuid: value }, 'original');
    expect(notice?.correlationId).toMatch(/^[a-f0-9-]{36}$/i);
    expect(JSON.stringify(notice)).not.toContain('PRIVATE');
  },
);

it('distinguishes settings-only loss and handles unknown future loss categories safely', () => {
  const settings = sdkPersistenceDiagnostic({ ...loss, lost: ['global_config'] }, 'original');
  expect(settings?.error).toMatch(/settings/i);
  expect(settings?.error).not.toMatch(/transcript/i);
  const unknown = sdkPersistenceDiagnostic({ ...loss, lost: ['PRIVATE_FUTURE'] }, 'original');
  expect(unknown?.error).toMatch(/native session data/i);
  expect(JSON.stringify(unknown)).not.toContain('PRIVATE');
});

it('keeps original evidence host-internal, session-scoped and bounded', () => {
  const original = { ...loss, error: 'PRIVATE_NATIVE_CAUSE' };
  retainSdkPersistenceFailure(uuid, 'original', original);
  expect(sdkPersistenceFailure(uuid, 'original')?.event).toBe(original);
  expect(sdkPersistenceFailure(uuid, 'foreign')).toBeUndefined();
  for (let i = 0; i < 32; i++) retainSdkPersistenceFailure(`bounded-${i}`, 'original', loss);
  expect(sdkPersistenceFailure(uuid, 'original')).toBeUndefined();
  expect(sdkPersistenceFailure('bounded-31', 'original')?.event).toBe(loss);
});
