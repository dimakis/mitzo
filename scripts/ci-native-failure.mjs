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

/** Only for the no-login kernel fixture, whose home and files are synthetic.
 * Keep this in its JSON artifact, never in public annotations. Do not pass
 * provider commands or operator payloads to this diagnostic. */
export function syntheticKernelCommandReport(profile, result, fixtureRoot) {
  if (!fixtureRoot) throw Error('Synthetic fixture root required');
  const stderr = stripVTControlCharacters(
    typeof result?.stderr === 'string' ? result.stderr.slice(0, 8192) : '',
  ).replaceAll(fixtureRoot, '<fixture-root>');
  return {
    profile: /^[a-zA-Z0-9_-]{1,100}$/.test(profile) ? profile : 'unknown',
    exitCode: Number.isSafeInteger(result?.exitCode) ? result.exitCode : null,
    stderr: Array.from(stderr, (character) => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159) ? ' ' : character;
    })
      .join('')
      .slice(0, 4096)
      .trimEnd(),
  };
}
