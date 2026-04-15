// Re-export from @mitzo/harness. The canonical implementation lives there.
// Server code continues importing from './session-registry.js' unchanged.
export { SessionRegistry } from '@mitzo/harness';
export type {
  ManagedSession,
  ActiveSessionInfo,
  MitzoMode,
  SnapshotBlock,
  MessageSnapshot,
  RawToolInput,
} from '@mitzo/harness';
