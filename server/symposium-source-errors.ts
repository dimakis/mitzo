/** Fixed source-domain messages only; never expose filesystem, transport or parser details. */
export class SourceImportError extends Error {}
export function sourceImportPublicError(error: unknown): string {
  return error instanceof SourceImportError
    ? error.message
    : 'Source import unavailable or incomplete. Refresh status; do not retry an unresolved import.';
}
