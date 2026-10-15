/** Selecting a command edits the draft; dispatch remains a separate user action. */
export function insertComposerCommand(draft: string, name: string): string {
  const leading = draft.trimStart();
  const argumentsText = leading.startsWith('/') ? leading.replace(/^\/[^\s]*(?:\s)?/, '') : draft;
  return `/${name} ${argumentsText}`;
}
