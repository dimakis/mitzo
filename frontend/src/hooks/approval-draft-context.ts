import { createContext } from 'react';
import type { PermissionDraft } from '../components/PermissionBanner';

export class ApprovalDraftStore {
  readonly requests = new Map<string, PermissionDraft>();
  selection?: { scope: string; id: string | null | undefined; seen: boolean };
  constructor(readonly sessionId?: string) {}
}
export const approvalDraftContext = createContext<ApprovalDraftStore | null>(null);
