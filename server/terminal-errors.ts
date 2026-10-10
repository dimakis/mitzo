/** Confirmed absence is distinct from an uncertain transport failure. */
export class TerminalSessionMissing extends Error {
  constructor() {
    super('The saved terminal shell has ended');
    this.name = 'TerminalSessionMissing';
  }
}
