// Re-export from @mitzo/protocol — this file exists for backwards compatibility
// during the migration. Server consumers should eventually import from @mitzo/protocol directly.
export { getRawInput, getToolInputSpanAttrs, summarizeToolInput } from '@mitzo/protocol';
export type { RawToolInput } from '@mitzo/protocol';
