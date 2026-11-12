import { CodexRequestError, CodexTransportError } from './codex-app-server-client.js';
import { nativeFailureCategories } from './codex-native-diagnostics.js';
import { ProviderFailureError, providerFailureTelemetry } from './provider-failure.js';
import { CodexStartupError } from './codex-startup-error.js';
import { RuntimePolicyAttestationError } from './openshell-runtime-policy.js';
import { findSessionRuntimeError } from './session-runtime-error.js';
import { NativeExecutionPolicyChangedError } from './codex-native-execution-policy.js';
import { CodexToolValidationError } from './codex-tool-validation-error.js';

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
  const retained = findSessionRuntimeError(error);
  if (retained) return retained.message;
  if (error.message === 'OpenShell ChatGPT grant is expired, revoked, or requires sign-in')
    return 'The selected ChatGPT connection needs a fresh sign-in. Reconnect that account before retrying.';
  if (error instanceof RuntimePolicyAttestationError)
    return 'The observed sandbox policy differs from the reviewed runtime contract. Check runtime configuration before retrying.';
  if (error.message === 'Codex startup provider initialization outcome is unverified')
    return 'Native chat initialization has an unverified outcome. Saved work is preserved; inspect recovery before retrying.';
  if (error.message === 'Codex conversation binding unavailable or changed')
    return 'This chat has no matching native conversation binding. Its saved messages are preserved. Inspect startup recovery before continuing.';
  if (error instanceof CodexTransportError) {
    if (error.diagnostic?.reason === 'host_tool_admission_timeout')
      return 'Mitzo workspace validation timed out before this tool was admitted. Saved work is preserved; inspect conversation recovery before continuing.';
    if (error.diagnostic?.reason === 'host_response_fence_failed')
      return 'Mitzo could not verify that a tool reply still belongs to the active session. Saved work is preserved; inspect conversation recovery before continuing.';
    if (error.diagnostic?.reason === 'reply_provenance_failed')
      return 'Mitzo could not verify the reply’s execution identity. Saved work is preserved; reconcile this conversation before continuing.';
    if (error.diagnostic?.reason === 'frame_too_large')
      return 'A Codex response exceeded Mitzo’s bounded transport limit. Saved work is preserved; inspect runtime diagnostics before retrying.';
    if (error.diagnostic?.reason === 'notification_handler_failed')
      return 'Mitzo could not process a Codex event. Inspect conversation recovery before retrying.';
    return {
      environment_pending:
        'Approved integration access is retained, but its workload environment is still pending. No new model turn was started. Retry when the provider environment has synchronized.',
      timeout: 'The Codex connection timed out. Inspect saved work before retrying.',
      connection: 'The Codex connection closed. Inspect conversation recovery before retrying.',
      protocol:
        'The Codex connection returned an invalid response. Inspect runtime diagnostics before retrying.',
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
  return projectRuntimeErrorTelemetry(error, new Set());
}
function projectRuntimeErrorTelemetry(error: Error, seen: Set<Error>): Record<string, unknown> {
  if (seen.size >= 16 || seen.has(error)) return {};
  seen.add(error);
  const retained = findSessionRuntimeError(error);
  if (retained)
    return {
      ...(retained.cause instanceof Error
        ? projectRuntimeErrorTelemetry(retained.cause, seen)
        : {}),
      ...retained.telemetry(),
      ...(retained instanceof CodexToolValidationError ? retained.validationTelemetry() : {}),
      ...(retained instanceof NativeExecutionPolicyChangedError
        ? { nativePolicyChangedFields: retained.changedFields }
        : {}),
    };
  if (error.message === 'OpenShell ChatGPT grant is expired, revoked, or requires sign-in')
    return { subscriptionSignInRequired: true };
  if (error instanceof RuntimePolicyAttestationError)
    return { runtimePolicyAttestationFailed: true };
  if (error instanceof CodexStartupError)
    return {
      ...(error.cause instanceof Error ? projectRuntimeErrorTelemetry(error.cause, seen) : {}),
      ...error.telemetry(),
    };
  if (error.message === 'Codex conversation binding unavailable or changed')
    return { conversationBindingUnavailable: true };
  if (error instanceof ProviderFailureError) return providerFailureTelemetry(error.failure);
  if (error instanceof CodexTransportError) {
    const diagnostic = error.diagnostic;
    const frameBytes = diagnostic?.frameBytes;
    const limitBytes = diagnostic?.limitBytes;
    return {
      transportErrorCategory: error.category,
      ...(diagnostic ? { transportFailureReason: diagnostic.reason } : {}),
      ...(diagnostic?.reason === 'child_exit'
        ? { nativeExitCode: diagnostic.exitCode, nativeExitSignal: diagnostic.signal }
        : {}),
      ...(diagnostic?.stream ? { nativeFailureStream: diagnostic.stream } : {}),
      ...(diagnostic?.causeCode ? { nativeFailureCode: diagnostic.causeCode } : {}),
      ...(diagnostic?.pendingRequestMethod && requestMethods.has(diagnostic.pendingRequestMethod)
        ? { pendingRequestMethod: diagnostic.pendingRequestMethod }
        : {}),
      ...(typeof frameBytes === 'number' && Number.isSafeInteger(frameBytes) && frameBytes >= 0
        ? { transportFrameBytes: frameBytes }
        : {}),
      ...(typeof limitBytes === 'number' && Number.isSafeInteger(limitBytes) && limitBytes > 0
        ? { transportFrameLimitBytes: limitBytes }
        : {}),
    };
  }
  if (!(error instanceof CodexRequestError))
    return error.cause instanceof Error ? projectRuntimeErrorTelemetry(error.cause, seen) : {};
  return {
    ...(requestMethods.has(error.method) ? { requestMethod: error.method } : {}),
    requestErrorCategory: nativeFailureCategories.includes(error.category)
      ? error.category
      : 'unknown',
    ...(Number.isSafeInteger(error.code) ? { requestErrorCode: error.code } : {}),
  };
}
