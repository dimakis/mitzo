export interface SandboxPoolSettings {
  enabled: boolean;
  capacity: number;
  refill: 'auto' | 'manual';
  expiryMinutes: number;
  cpu: number;
  memoryGiB: number;
}
export interface SandboxSpare {
  id: string;
  name: string;
  physicalId: string | null;
  state: string;
  resources: { cpu: number; memoryGiB: number };
  failure: string | null;
  observedState?: string;
  /** Fresh server observation; mutations still recheck physical ownership. */
  canRetire?: boolean;
  observedAt?: number;
}
export interface SandboxConversation {
  conversationId: string;
  sandboxName: string;
  state: string;
  account: string;
  title: string;
  canReviewCleanup: boolean;
}
export interface SandboxesInventory {
  physicalInventory?: {
    available: boolean;
    error?: string;
    total?: number;
    counts?: Record<string, number>;
    observedAt?: number;
    items?: Array<{ id: string; name: string; state: string; management: string }>;
  };
  revision: number;
  settings: SandboxPoolSettings;
  resting: boolean;
  busy: boolean;
  available: boolean;
  reason: string | null;
  capabilities: { cpu: boolean; memory: boolean; disk: boolean; diskReason: string };
  spares: SandboxSpare[];
  conversations: SandboxConversation[];
}
export interface SandboxCleanupPreview {
  token: string;
  action: 'stop' | 'stop_and_delete' | 'delete' | 'none';
  blockers: string[];
  expiresAt: number;
  retention?: { enabled: boolean; deleteAfter: number | null; days: number };
}
