const messages = {
  workspace_changed:
    'The chat’s workspace changed. Keep the chat and review its current workspace before deleting.',
  commands_pending: 'Commands are still queued or running. Wait for shutdown, then review again.',
  transition_pending:
    'A workspace change is unfinished. Keep the chat and finish or reconcile that change before deleting.',
  tool_result_pending:
    'A tool call has no verified result. Keep the chat and review its unfinished work before deleting.',
  recovery_required:
    'Interrupted work still needs recovery review. Keep the chat and resolve its recovery state before deleting.',
} as const;

/** Reviewed messages never expose workspace paths, prompts or tool payloads. */
export class SessionRemovalBlocker extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = 'SessionRemovalBlocker';
  }
}
