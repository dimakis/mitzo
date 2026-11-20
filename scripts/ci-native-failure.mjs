import { stripVTControlCharacters } from 'node:util';

/** Never copy assertion messages, command output, credentials or absolute paths
 * into public annotations. Original exceptions/reporters retain the cause. */
export function nativeCiFailure(stage, error) {
  const stack = stripVTControlCharacters(
    typeof error?.stack === 'string' ? error.stack.slice(0, 32768) : '',
  );
  const diagnostic = {
    code: 'ci_native_verification_failed',
    stage: /^[a-z0-9-]{1,100}$/.test(stage) ? stage : 'unknown',
    errorClass:
      /^(AssertionError|TypeError|Error|ZodError|SessionRuntimeError)\b/.exec(stack)?.[1] ??
      'Error',
    source:
      /\b((?:scripts|server|tests)\/[a-zA-Z0-9_./-]+\.(?:mjs|js|ts|tsx):\d+:\d+)/.exec(
        stack,
      )?.[1] ?? 'unavailable',
  };
  return {
    diagnostic,
    annotation: `::error title=Native CI verification failed::${Object.entries(diagnostic)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ')}`,
  };
}
