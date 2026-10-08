import { randomUUID } from 'node:crypto';

const phases = {
  runtime_admission: 'runtime admission',
  sandbox_preparation: 'sandbox preparation',
  conversation_storage: 'conversation storage',
  context_preparation: 'context preparation',
  runtime_connection: 'runtime connection',
  conversation_initialization: 'conversation initialization',
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
    if (this.cause instanceof CodexStartupError) return this.cause.resourceErrorCode();
    if (!(this.cause instanceof Error) || !('code' in this.cause)) return undefined;
    const code = this.cause.code;
    return typeof code === 'string' && errorCodes.has(code) ? code : undefined;
  }

  publicMessage(detail?: string): string {
    const code = this.resourceErrorCode();
    const resourceReason = code ? errorCodes.get(code) : undefined;
    if (this.phase === 'initial_turn_dispatch')
      return `The first turn could not be confirmed. ${(detail ?? resourceReason) ? (detail ?? resourceReason) + ' ' : ''}Its outcome may be unknown; inspect saved work before continuing.`;
    const explanation =
      detail ??
      `${resourceReason ? resourceReason + ' ' : ''}Check runtime and account configuration before continuing.`;
    return `Chat startup failed during ${phases[this.phase]}. ${explanation}`;
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
    const location =
      this.cause instanceof Error
        ? this.cause.stack
            ?.slice(0, 16_000)
            ?.split('\n')
            .find((line) => {
              const frame = /\/(?:server|dist)\/([a-z-]+)\.(?:ts|js):(\d{1,6}):(\d{1,6})\)?$/.exec(
                line,
              );
              return frame && diagnosticFiles.has(frame[1]);
            })
            ?.match(/\/(?:server|dist)\/([a-z-]+)\.(?:ts|js):(\d{1,6}):(\d{1,6})\)?$/)
        : undefined;
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
  try {
    return await action();
  } catch (cause) {
    if (cause instanceof CodexStartupError) throw cause;
    throw new CodexStartupError(phase, cause);
  }
}
