/** Fixed, public-safe phases; never copy provider or filesystem errors here. */
export type AdviserHarnessPhase =
  | 'workspace_prepare'
  | 'workspace_reserve'
  | 'dispatch_authority'
  | 'session_metadata'
  | 'command_dispatch'
  | 'provider_response';
export class AdviserHarnessFailure extends Error {
  constructor(readonly phase: AdviserHarnessPhase) {
    super('Adviser harness could not complete');
  }
}
