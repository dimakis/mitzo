import { randomUUID } from 'node:crypto';

interface PersistenceFailure {
  sessionId: string;
  event: Record<string, unknown>;
  reportingCause?: unknown;
}
const failures = new Map<string, PersistenceFailure>();

/** Bounded host-internal evidence; never serialize this record to a client or log. */
export function retainSdkPersistenceFailure(
  id: string,
  sessionId: string,
  event: Record<string, unknown>,
) {
  failures.set(id, { sessionId, event });
  if (failures.size > 32) failures.delete(failures.keys().next().value!);
}

export function sdkPersistenceFailure(id: string, sessionId: string) {
  const failure = failures.get(id);
  return failure?.sessionId === sessionId ? failure : undefined;
}

/** SDK persistence notices carry no turn output and never revise its result. */
export function sdkPersistenceDiagnostic(event: Record<string, unknown>, sessionId: string) {
  if (
    !sessionId ||
    event.type !== 'system' ||
    event.session_id !== sessionId ||
    event.parent_tool_use_id != null ||
    !['session_writes_lost', 'mirror_error'].includes(String(event.subtype))
  )
    return;
  if (event.subtype === 'mirror_error') {
    const key = event.key;
    if (!key || typeof key !== 'object' || !('sessionId' in key) || key.sessionId !== sessionId)
      return;
  }
  // Neither native error strings, project paths nor foreign transcript IDs are public diagnostics.
  const uuid =
    typeof event.uuid === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(event.uuid)
      ? event.uuid
      : randomUUID();
  const lost = Array.isArray(event.lost) ? event.lost : [];
  const subject = lost.includes('transcript')
    ? 'native transcript'
    : lost.includes('global_config')
      ? 'native settings'
      : 'native session data';
  return {
    nonfatal: true as const,
    stage: 'native_persistence',
    correlationId: uuid,
    code: event.subtype === 'mirror_error' ? 'claude_mirror_error' : 'claude_session_writes_lost',
    error:
      event.subtype === 'mirror_error'
        ? 'Claude could not save a transcript mirror batch. Received results remain available in Mitzo; native resume is unverified. Inspect the original session before continuing.'
        : `Claude could not save some ${subject} changes. Received results remain available in Mitzo; saving to native storage is not verified. Check available disk space and inspect the original session before continuing.`,
  };
}
