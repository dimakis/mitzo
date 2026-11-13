import { assertOrdinarySynchronousFence } from './ordinary-turn-lifecycle.js';

/** Host-only denial fence for one pending first command. It cannot admit work,
 * supply credentials, or replace the ordinary worker/operator guards. */
export interface OrdinaryFirstCommandAuthority {
  readonly commandId: string;
  assertCurrent(): void;
}

export function captureOrdinaryFirstCommandAuthority(
  input: OrdinaryFirstCommandAuthority | undefined,
  commandId: string,
): OrdinaryFirstCommandAuthority | undefined {
  if (!input) return undefined;
  if (input.commandId !== commandId || typeof input.assertCurrent !== 'function')
    throw Error('Exact first-command authority required');
  const assertCurrent = input.assertCurrent.bind(input);
  return Object.freeze({
    commandId,
    assertCurrent: () => assertOrdinarySynchronousFence(commandId, assertCurrent),
  });
}
