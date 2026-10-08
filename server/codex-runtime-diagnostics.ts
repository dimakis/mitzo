import { CodexRequestError, CodexTransportError } from './codex-app-server-client.js';
import { nativeFailureCategories } from './codex-native-diagnostics.js';
import { ProviderFailureError, providerFailureTelemetry } from './provider-failure.js';
import { CodexStartupError } from './codex-startup-error.js';
import { RuntimePolicyAttestationError } from './openshell-runtime-policy.js';

const requestMethods = new Set([
  'initialize',
  'account/read',
  'model/list',
  'config/read',
  'thread/start',
  'thread/resume',
  'thread/fork',
  'thread/read',
  'thread/turns/list',
  'turn/start',
  'turn/interrupt',
]);

/** Only fixed diagnostics from typed errors; never relay upstream exception text. */
export function codexRuntimeDiagnostic(error: Error): string | undefined {
  if (error instanceof RuntimePolicyAttestationError)
    return 'The observed sandbox policy differs from the reviewed runtime contract. Check runtime configuration before retrying.';
  if (error.message === 'Codex startup provider initialization outcome is unverified')
    return 'Native chat initialization has an unverified outcome. Saved work is preserved; inspect recovery before retrying.';
  if (error.message === 'Codex conversation binding unavailable or changed')
    return 'This chat has no matching native conversation binding. Its saved messages are preserved. Inspect startup recovery before continuing.';
  if (error instanceof CodexTransportError) {
    return {
      timeout: 'The Codex connection timed out. Inspect saved work before retrying.',
      connection: 'The Codex connection closed. Inspect conversation recovery before retrying.',
      protocol:
        'The Codex connection returned an invalid response. Check runtime compatibility before retrying.',
    }[error.category];
  }
  if (!(error instanceof CodexRequestError)) return undefined;
  switch (error.category) {
    case 'authentication':
      return 'Codex rejected the configured account credentials or permissions. Check the selected account before retrying.';
    case 'rate_limit':
      return 'The selected account reached a usage or rate limit. Check its limits before retrying.';
    case 'context_limit':
      return 'Codex rejected the request because its context is too large. Inspect conversation recovery before continuing.';
    case 'thread_state':
      return 'The provider thread is busy or in an incompatible state. Inspect conversation recovery before retrying.';
    case 'provider_transport':
      return 'The provider connection was interrupted. Inspect saved work before retrying.';
    default:
      return nativeFailureCategories.includes(error.category) &&
        error.category.startsWith('routing_')
        ? 'Codex workspace routing failed. Check the selected account and workspace configuration before retrying.'
        : 'Codex rejected a runtime request. Check runtime and account configuration before retrying.';
  }
}

/** Shared by startup and running turns, with bounded fields safe for logs. */
export function codexRuntimeErrorTelemetry(error: Error): Record<string, unknown> {
  if (error instanceof RuntimePolicyAttestationError)
    return { runtimePolicyAttestationFailed: true };
  if (error instanceof CodexStartupError)
    return {
      ...(error.cause instanceof Error ? codexRuntimeErrorTelemetry(error.cause) : {}),
      ...error.telemetry(),
    };
  if (error.message === 'Codex conversation binding unavailable or changed')
    return { conversationBindingUnavailable: true };
  if (error instanceof ProviderFailureError) return providerFailureTelemetry(error.failure);
  if (error instanceof CodexTransportError) return { transportErrorCategory: error.category };
  if (!(error instanceof CodexRequestError)) return {};
  return {
    ...(requestMethods.has(error.method) ? { requestMethod: error.method } : {}),
    requestErrorCategory: nativeFailureCategories.includes(error.category)
      ? error.category
      : 'unknown',
    ...(Number.isSafeInteger(error.code) ? { requestErrorCode: error.code } : {}),
  };
}
