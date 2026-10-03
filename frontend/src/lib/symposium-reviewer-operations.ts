import type { SymposiumConfig } from '@mitzo/protocol';
import type { AccountSelection } from '../components/AccountModelPicker';
import type { SymposiumProfileSelection } from '../components/SymposiumProfilePicker';
export type ReviewerApproval = {
  selection: AccountSelection;
  profile: SymposiumProfileSelection | null;
  name: string;
  role: string;
  instructions: string;
  expectedOutput: string;
  criteria: string;
  authority: { filesystem: 'read' | 'write'; tools: 'read' | 'write'; network: 'restricted' };
  mode: 'independent' | 'summary' | 'selected-turns' | 'full-context';
  brief: string;
  summary: string;
  turnIds: string[];
  acknowledged: boolean;
  typed: string;
};
export type ReviewerMutation = {
  path: string;
  body: Record<string, unknown>;
  method: string;
  fingerprint: string;
  admissionGoal?: { config: SymposiumConfig; members: { seatId: string; generation: number }[] };
};
export type ReviewerOperation = {
  sessionId: string;
  generic: boolean;
  seatId: string;
  key: string;
  approval: ReviewerApproval;
  pending: boolean;
  context?: { content: string };
  seat?: SymposiumConfig['seats'][number];
  configurationSnapshot?: SymposiumConfig;
  uncertain?: ReviewerMutation;
  committed: Record<string, unknown>;
  done: boolean;
  notice: string;
};
let operations: Record<string, ReviewerOperation> = {};
const listeners = new Set<() => void>();
/** Approved content stays only in page memory. Keyed chat unmounts never release a pending mutation. */
export const reviewerOperationScope = (sessionId: string, generic: boolean) =>
  JSON.stringify([sessionId, generic]);
export const reviewerOperations = {
  snapshot: () => operations,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  update(scope: string, operation: ReviewerOperation | undefined) {
    operations = { ...operations };
    if (operation) operations[scope] = operation;
    else delete operations[scope];
    listeners.forEach((listener) => listener());
  },
  reset() {
    operations = {};
    listeners.forEach((listener) => listener());
  },
};
