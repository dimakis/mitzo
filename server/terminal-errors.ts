/** Confirmed absence is distinct from an uncertain transport failure. */
export class TerminalSessionMissing extends Error {
  constructor() {
    super('The saved terminal shell has ended');
    this.name = 'TerminalSessionMissing';
  }
}

const failures = {
  terminal_open_failed: [
    'open',
    'Terminal could not be opened. Retry or choose another environment.',
  ],
  terminal_start_failed: [
    'start',
    'Terminal could not be opened because its shell transport failed. Retry or check the terminal service on the Mac.',
  ],
  terminal_limit_reached: [
    'capacity',
    'The terminal limit has been reached. End an unused terminal, then retry.',
  ],
  terminal_workspace_unavailable: [
    'workspace',
    'This chat’s workspace is unavailable. Resume the original chat, then retry.',
  ],
  terminal_sandbox_unavailable: [
    'sandbox',
    'This chat’s original sandbox is unavailable. Resume the original chat, then retry.',
  ],
  terminal_binding_changed: [
    'binding',
    'This chat’s saved environment no longer matches its current account or workspace. Resume the original chat, then retry.',
  ],
  terminal_destination_ambiguous: [
    'destination',
    'Choose a specific agent’s chat environment for this conversation.',
  ],
} as const;

/** Only these bounded messages may cross the operator API. Keep raw causes internal. */
export class TerminalOperationError extends Error {
  readonly stage: string;
  constructor(
    readonly code: keyof typeof failures,
    cause?: unknown,
  ) {
    super(failures[code][1], { cause });
    this.name = 'TerminalOperationError';
    this.stage = failures[code][0];
  }
}

/** Process errors can contain SSH grant tokens in message, stack, args and stderr. */
export function terminalFailureDiagnostic(error: TerminalOperationError) {
  let cause: unknown = error;
  const causes: string[] = [];
  for (let depth = 0; depth < 5 && cause instanceof Error; depth++) {
    if (cause instanceof TerminalOperationError) causes.push(cause.code);
    else if (
      'code' in cause &&
      typeof cause.code === 'string' &&
      [
        'ENOENT',
        'EACCES',
        'EPERM',
        'ENOSPC',
        'EMFILE',
        'ENFILE',
        'ETIMEDOUT',
        'ECONNREFUSED',
      ].includes(cause.code)
    )
      causes.push(cause.code);
    else if (cause.message === 'posix_spawnp failed.' || cause.message === 'forkpty(3) failed.')
      causes.push('pty_spawn_failed');
    else causes.push('unclassified_error');
    cause = cause.cause;
  }
  return { code: error.code, stage: error.stage, causes };
}
