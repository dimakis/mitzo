import { randomUUID } from 'node:crypto';
import { SpanStatusCode } from '@opentelemetry/api';
import { tracer } from './tracing.js';

const phases = {
  runtime_admission: 'runtime admission',
  sandbox_preparation: 'sandbox preparation',
  conversation_storage: 'conversation storage',
  context_preparation: 'context preparation',
  runtime_connection: 'runtime connection',
  conversation_initialization: 'conversation initialization',
  initial_turn_preparation: 'first turn preparation',
  initial_turn_dispatch: 'initial turn dispatch',
} as const;
const errorCodes = new Map([
  ['ENOSPC', 'Sandbox or host storage is full.'],
  ['EACCES', 'The runtime could not access a required file or resource.'],
  ['EPERM', 'The runtime lacks a required permission.'],
  ['ENOENT', 'A required runtime file or resource is missing.'],
  ['ECONNREFUSED', 'A required runtime service is not accepting connections.'],
  ['ECONNRESET', 'A required runtime connection was interrupted.'],
  ['ENOTFOUND', 'A required runtime service could not be found.'],
  ['ETIMEDOUT', 'A required runtime operation timed out.'],
  ['SQLITE_FULL', 'Conversation storage is full.'],
  ['SQLITE_CANTOPEN', 'Conversation storage could not be opened.'],
  ['SQLITE_BUSY', 'Conversation storage is busy.'],
]);
const diagnosticFiles = new Set([
  'telos-work-store',
  'telos-work-command-scope',
  'telos-work-execution-authority',
  'chat',
  'ordinary-openshell-codex-entry',
  'ordinary-openshell-codex-entry-owner',
  'ordinary-openshell-codex-owned-runtime',
  'ordinary-local-codex-owned-runtime',
  'ordinary-local-codex-admission',
  'frozen-host-codex-bootstrap',
  'owned-openshell-codex-chat-admission',
  'openshell-runtime',
  'codex-chat-session',
  'codex-conversation',
  'codex-conversation-store',
  'codex-app-server-client',
  'knowledge-publication-bridge',
  'knowledge-view',
  'connections-service',
  'connections-gateway',
]);

/** Keep the cause internally; messages and logs use only reviewed fields. */
export class CodexStartupError extends Error {
  readonly diagnosticId = randomUUID();
  constructor(
    readonly phase: keyof typeof phases,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : 'Codex startup failed', { cause });
    this.name = 'CodexStartupError';
  }

  resourceErrorCode(): string | undefined {
    for (const cause of this.causes()) {
      const code = 'code' in cause ? cause.code : undefined;
      if (typeof code === 'string' && errorCodes.has(code)) return code;
    }
    return undefined;
  }

  private *causes(): Generator<Error> {
    const seen = new Set<Error>();
    let cause = this.cause;
    for (let depth = 0; depth < 16 && cause instanceof Error && !seen.has(cause); depth++) {
      seen.add(cause);
      yield cause;
      cause = cause.cause;
    }
  }

  publicMessage(detail?: string): string {
    const code = this.resourceErrorCode();
    const resourceReason = code ? errorCodes.get(code) : undefined;
    if (this.phase === 'initial_turn_dispatch')
      return `The first turn could not be confirmed. ${(detail ?? resourceReason) ? (detail ?? resourceReason) + ' ' : ''}Its outcome may be unknown; inspect saved work before continuing.`;
    const explanation =
      detail ??
      `${resourceReason ? resourceReason + ' ' : ''}Check runtime and account configuration before continuing.`;
    return `Chat startup failed during ${phases[this.phase]}. ${explanation}${this.phase === 'initial_turn_preparation' ? ' No provider turn was started.' : ''}`;
  }

  telemetry(): Record<string, unknown> {
    const code = this.resourceErrorCode();
    const commandCode =
      this.cause instanceof Error && 'cmd' in this.cause && 'code' in this.cause
        ? this.cause.code
        : undefined;
    const exitCode =
      typeof commandCode === 'number' &&
      Number.isSafeInteger(commandCode) &&
      commandCode >= 0 &&
      commandCode <= 255
        ? commandCode
        : undefined;
    const signal =
      this.cause instanceof Error && 'signal' in this.cause ? this.cause.signal : undefined;
    // Only reviewed application filenames and numeric locations, never upstream
    // exception text, absolute paths, commands, URLs or the complete stack.
    // Prefer the original reviewed guard over a generic outer admission wrapper.
    let location: RegExpMatchArray | null | undefined;
    for (const cause of this.causes()) {
      const frame = cause.stack
        ?.slice(0, 16_000)
        ?.split('\n')
        .find((line) => {
          const frame = /\/(?:server|dist)\/([a-z-]+)\.(?:ts|js):(\d{1,6}):(\d{1,6})\)?$/.exec(
            line,
          );
          return frame && diagnosticFiles.has(frame[1]);
        })
        ?.match(/\/(?:server|dist)\/([a-z-]+)\.(?:ts|js):(\d{1,6}):(\d{1,6})\)?$/);
      if (frame) location = frame;
    }
    return {
      startupPhase: this.phase,
      diagnosticId: this.diagnosticId,
      ...(code ? { startupErrorCode: code } : {}),
      ...(exitCode === undefined ? {} : { startupExitCode: exitCode }),
      ...(typeof signal === 'string' && ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT'].includes(signal)
        ? { startupSignal: signal }
        : {}),
      ...(location ? { startupErrorLocation: `${location[1]}:${location[2]}:${location[3]}` } : {}),
    };
  }
}

export async function duringCodexStartup<T>(
  phase: ConstructorParameters<typeof CodexStartupError>[0],
  action: () => T | Promise<T>,
): Promise<T> {
  // Internal fixed phases and status only: native causes can contain secrets.
  const span = tracer.startSpan(`codex.startup.${phase}`);
  try {
    const result = await action();
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (cause) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    if (cause instanceof CodexStartupError) throw cause;
    throw new CodexStartupError(phase, cause);
  } finally {
    span.end();
  }
}
