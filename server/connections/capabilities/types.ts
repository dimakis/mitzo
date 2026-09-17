import type { JsonSchema, JsonValue } from '../types.js';

/**
 * Controller-side capabilities are deliberately separate from OpenShell
 * provider policies.  Nothing in this contract names a command, a path to an
 * executable, or a credential.
 */
export type CapabilityOperationStatus =
  | 'pending_approval'
  | 'running'
  /** Mutation may have reached the provider; only recovery verification may settle it. */
  | 'verification_pending'
  | 'succeeded'
  | 'denied'
  | 'cancelled'
  | 'failed';

export interface CapabilityGrant {
  id: string;
  connectionId: string;
  connectionRevision: number;
  capabilityId: string;
  capabilityVersion: number;
  accountIds: readonly string[];
  status: 'active' | 'revoked';
  createdAt: number;
  updatedAt: number;
}

export interface CapabilityOperation {
  id: string;
  connectionId: string;
  connectionRevision: number;
  capabilityId: string;
  capabilityVersion: number;
  grantId: string;
  accountId: string;
  conversationId: string;
  turnId: string;
  idempotencyKey: string;
  inputHash: string;
  status: CapabilityOperationStatus;
  externalResultId: string | null;
  /** Already redacted and capped; never holds a request input or a credential. */
  result: JsonValue | null;
  /** Stable public error code only; raw errors are never durable. */
  failureCode: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CapabilityConnection {
  id: string;
  templateId: string;
  templateVersion: number;
  revision: number;
  status: string;
  desiredAccountIds: readonly string[];
}

export interface CapabilityExecutionContext {
  /** `operation.id` is the mandatory external idempotency and recovery key. */
  operation: CapabilityOperation;
  input: Readonly<Record<string, string | boolean>>;
  signal: AbortSignal;
}

export interface CapabilityExecutorResult {
  output: JsonValue;
  externalResultId?: string;
}

/** `verify` is mandatory: a mutation is not reported as successful until read-after-write confirms it. */
export interface CapabilityExecutor {
  readonly inputSchema?: JsonSchema;
  execute(context: CapabilityExecutionContext): Promise<CapabilityExecutorResult>;
  verify(context: CapabilityExecutionContext, result: CapabilityExecutorResult): Promise<void>;
  /**
   * Restart/reconnect recovery. Must use durable operation identity and a
   * read-after-write query only; it must never issue a mutation.
   */
  recover(operation: CapabilityOperation, signal: AbortSignal): Promise<void>;
}

export interface CapabilityRequest {
  capabilityId: string;
  capabilityVersion: number;
  connectionId: string;
  connectionRevision: number;
  accountId: string;
  conversationId: string;
  turnId: string;
  idempotencyKey: string;
  input: unknown;
}

export interface CapabilityApprovalRequest {
  capabilityId: string;
  capabilityVersion: number;
  connectionId: string;
  operationId: string;
  input: Readonly<Record<string, string | boolean>>;
  /** Always true. Callers must present a real approval card. */
  forcePrompt: true;
}

export type CapabilityApproval = (
  request: CapabilityApprovalRequest,
  signal: AbortSignal,
) => Promise<boolean>;
