import { trace } from '@opentelemetry/api';
import {
  beginOperationObservation,
  observeOperationAsync,
  observeOperationSync,
} from './operation-observation.js';

type Phase =
  | 'request'
  | 'read'
  | 'events_read'
  | 'workspace_recovery'
  | 'legacy_read'
  | 'projection'
  | 'serialize'
  | 'response_write';

export function annotateTranscriptAge(createdAt: number | undefined): void {
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return;
  try {
    trace
      .getActiveSpan()
      ?.setAttribute('transcript.session_age_ms', Math.max(0, Date.now() - createdAt));
  } catch {
    /* Observation only. */
  }
}
export function beginTranscriptObservation(
  phase: Phase,
  attributes: Record<string, string | number | boolean> = {},
) {
  return beginOperationObservation(`transcript.${phase}`, attributes);
}
export function observeTranscriptSync<T>(
  phase: Phase,
  work: (observation: ReturnType<typeof beginTranscriptObservation>) => T,
): T {
  return observeOperationSync(`transcript.${phase}`, work);
}
export function observeTranscriptAsync<T>(phase: Phase, work: () => Promise<T>): Promise<T> {
  return observeOperationAsync(`transcript.${phase}`, work);
}
