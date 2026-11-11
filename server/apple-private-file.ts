import { closeSync } from 'node:fs';

/** Retain both causes if a private-file operation and its close fail. Never
 * return success with an unconfirmed write/close or replace the primary error. */
export function withAppleFile<T>(fd: number, operation: () => T): T {
  let value!: T;
  let failure: { cause: unknown } | undefined;
  try {
    value = operation();
  } catch (cause) {
    failure = { cause };
  }
  let closeFailure: { cause: unknown } | undefined;
  try {
    closeSync(fd);
  } catch (cause) {
    closeFailure = { cause };
  }
  if (closeFailure) {
    throw new Error('Apple private file close failed', {
      cause: failure ? new AggregateError([failure.cause, closeFailure.cause]) : closeFailure.cause,
    });
  }
  if (failure) throw failure.cause;
  return value;
}
