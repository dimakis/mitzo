import {
  OrdinaryWorkspacePreparationRequestSchema,
  OrdinaryWorkspacePreparationReceiptSchema,
  OrdinaryWorkspaceFirstCommandSchema,
  OrdinaryWorkspaceContinuationCommandSchema,
  LocalCodexFirstCommandReceiptSchema,
  OrdinaryCodexRetainedCommandObservationSchema,
  type OrdinaryWorkspacePreparationRequest,
  type OrdinaryWorkspaceFirstCommand,
  type OrdinaryWorkspaceContinuationCommand,
} from '@mitzo/protocol';
import type { ApiFetch } from './api-client.js';
import type { z } from 'zod';
export class OrdinaryWorkspaceApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly observation?: z.infer<typeof OrdinaryCodexRetainedCommandObservationSchema>,
  ) {
    super(message);
  }
}
/** Explicit authenticated requests only. No hidden retry or new command identity. */
export class OrdinaryWorkspaceApiClient {
  constructor(private fetch: ApiFetch) {}
  prepare(input: OrdinaryWorkspacePreparationRequest, signal?: AbortSignal) {
    return this.request(
      'prepare',
      OrdinaryWorkspacePreparationReceiptSchema,
      OrdinaryWorkspacePreparationRequestSchema.parse(input),
      signal,
    );
  }
  firstCommand(input: OrdinaryWorkspaceFirstCommand, signal?: AbortSignal) {
    return this.request(
      'commands/first',
      LocalCodexFirstCommandReceiptSchema,
      OrdinaryWorkspaceFirstCommandSchema.parse(input),
      signal,
    );
  }
  continueCommand(input: OrdinaryWorkspaceContinuationCommand, signal?: AbortSignal) {
    return this.request(
      'commands/continue',
      LocalCodexFirstCommandReceiptSchema,
      OrdinaryWorkspaceContinuationCommandSchema.parse(input),
      signal,
    );
  }
  private async request<T>(
    path: string,
    schema: { parse(value: unknown): T },
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.fetch('/api/ordinary/workspaces/' + path, {
      credentials: 'include',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      const observed = OrdinaryCodexRetainedCommandObservationSchema.safeParse(error);
      const submitted = OrdinaryWorkspaceFirstCommandSchema.safeParse(body);
      const observation =
        observed.success &&
        submitted.success &&
        observed.data.clientMsgId === submitted.data.clientMsgId &&
        observed.data.sessionId === submitted.data.sessionId
          ? observed.data
          : undefined;
      throw new OrdinaryWorkspaceApiError(
        response.status,
        typeof error?.code === 'string' ? error.code : 'unavailable',
        typeof error?.error === 'string' ? error.error : 'Ordinary workspace unavailable',
        observation,
      );
    }
    const result = schema.parse(await response.json());
    const submitted = OrdinaryWorkspaceFirstCommandSchema.safeParse(body);
    if (submitted.success) {
      const receipt = LocalCodexFirstCommandReceiptSchema.parse(result);
      if (
        receipt.clientMsgId !== submitted.data.clientMsgId ||
        receipt.sessionId !== submitted.data.sessionId
      )
        throw Error('Original ordinary command acknowledgement required');
    }
    return result;
  }
}
