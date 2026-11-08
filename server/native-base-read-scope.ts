import type { CodexNativeTurnTarget } from './codex-conversation-store.js';

/** Server-only facts from an exact live native callback. Base roots exclude
 * upstream grants; the original producer's fence expires with the callback. */
export interface NativeBaseReadScope {
  readonly nativeTarget: Readonly<CodexNativeTurnTarget>;
  readonly callId: string;
  readonly toolName: string;
  readonly requestHash: string;
  readonly bindingRevision: string;
  readonly profileRevision: string;
  readonly policyRevision: string;
  readonly readableRoots: readonly string[];
  readonly workspaceRoots: readonly string[];
  readonly deniedRoots: readonly string[];
  assertCurrentSync(): void;
}
