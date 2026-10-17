import {
  SessionCollaborationIdSchema,
  SessionCollaborationSchema,
  CollaborationBeginSchema,
  CollaborationPolicyUpdateSchema,
  CollaborationPolicySchema,
  CollaborationViewSchema,
  CollaborationEventsSchema,
  CollaborationCursorSchema,
  CollaborationSnapshotSchema,
  CollaborationJoinSchema,
  CollaborationJoinInputSchema,
  CollaborationJoinReconcileInputSchema,
  CollaborationMessageInputSchema,
  CollaborationMessageSchema,
  CollaborationSnapshotReferenceSchema,
  CollaborationSnapshotSelectionSchema,
  CollaborationApplicationReviewInputSchema,
  CollaborationApplicationReviewRequestSchema,
  CollaborationApplicationReviewResultSchema,
  type CollaborationApplicationReviewInput,
  type CollaborationSnapshotSelection,
  type CollaborationPolicyUpdate,
  type CollaborationMessageInput,
  type CollaborationJoinInput,
  type CollaborationJoinReconcileInput,
} from '@mitzo/protocol';
import type { z } from 'zod';
import type { ApiFetch } from './api-client.js';

export class CollaborationApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
/** Explicit reads and mutations only. No polling, implicit admission or response loops. */
export class CollaborationApiClient {
  constructor(private readonly fetch: ApiFetch) {}
  private path(id: string, suffix: string) {
    return `/api/session-collaborations/${SessionCollaborationIdSchema.parse(id)}/${suffix}`;
  }
  private async request<T>(
    url: string,
    schema: { parse(raw: unknown): T },
    signal?: AbortSignal,
    mutation?: { method: 'PUT' | 'POST'; body: unknown },
  ): Promise<T> {
    const response = await this.fetch(url, {
      credentials: 'include',
      signal,
      ...(mutation
        ? {
            method: mutation.method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(mutation.body),
          }
        : {}),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new CollaborationApiError(
        response.status,
        typeof body?.code === 'string' ? body.code : 'unavailable',
        typeof body?.error === 'string' ? body.error : 'Collaboration unavailable',
      );
    }
    return schema.parse(await response.json());
  }
  view(id: string, signal?: AbortSignal) {
    return this.request(this.path(id, 'conversation'), CollaborationViewSchema, signal);
  }
  /** Relationship preparation only; this does not allocate an agent or start a turn. */
  begin(id: string, input: z.infer<typeof CollaborationBeginSchema>, signal?: AbortSignal) {
    const group = SessionCollaborationIdSchema.parse(id);
    const body = CollaborationBeginSchema.parse(input);
    return this.request(
      this.path(group, 'begin'),
      SessionCollaborationSchema.refine(
        (receipt) =>
          receipt.collaborationId === group &&
          receipt.participantSessionIds.includes(body.sessionId),
        'Collaboration preparation identity changed',
      ),
      signal,
      { method: 'POST', body },
    );
  }
  events(id: string, after: number, signal?: AbortSignal) {
    const cursor = CollaborationCursorSchema.parse({ after });
    return this.request(
      this.path(id, `events?after=${cursor.after}`),
      CollaborationEventsSchema,
      signal,
    );
  }
  setPolicy(id: string, input: CollaborationPolicyUpdate) {
    return this.request(this.path(id, 'policy'), CollaborationPolicySchema, undefined, {
      method: 'PUT',
      body: CollaborationPolicyUpdateSchema.parse(input),
    });
  }
  snapshot(id: string, snapshotId: string, signal?: AbortSignal) {
    CollaborationSnapshotReferenceSchema.shape.snapshotId.parse(snapshotId);
    return this.request(
      this.path(id, `snapshots/${snapshotId}`),
      CollaborationSnapshotSchema,
      signal,
    );
  }
  /** Source compilation remains disabled; arbitrary client content is never source proof. */
  prepareSnapshot(id: string, input: CollaborationSnapshotSelection) {
    return this.request(this.path(id, 'snapshots'), CollaborationSnapshotSchema, undefined, {
      method: 'POST',
      body: CollaborationSnapshotSelectionSchema.parse(input),
    });
  }
  /** Observational review only; a successful response need not establish capacity. */
  review(
    id: string,
    clientId: string,
    input: CollaborationApplicationReviewInput,
    signal?: AbortSignal,
  ) {
    const body = CollaborationApplicationReviewRequestSchema.parse({
      ...CollaborationApplicationReviewInputSchema.parse(input),
      clientId,
    });
    return this.request(
      this.path(id, 'reviews'),
      CollaborationApplicationReviewResultSchema,
      signal,
      {
        method: 'POST',
        body,
      },
    );
  }
  join(id: string, joinId: string, signal?: AbortSignal) {
    CollaborationJoinSchema.shape.joinId.parse(joinId);
    return this.request(this.path(id, `joins/${joinId}`), CollaborationJoinSchema, signal);
  }
  /** The server currently refuses this with execution_unavailable. Never allocate on the client. */
  prepareJoin(id: string, input: CollaborationJoinInput) {
    return this.request(this.path(id, 'joins'), CollaborationJoinSchema, undefined, {
      method: 'POST',
      body: CollaborationJoinInputSchema.parse(input),
    });
  }
  recoverJoin(id: string, joinId: string, signal?: AbortSignal) {
    CollaborationJoinSchema.shape.joinId.parse(joinId);
    return this.request(this.path(id, `joins/${joinId}/recover`), CollaborationJoinSchema, signal, {
      method: 'POST',
      body: {},
    });
  }
  reconcileJoin(
    id: string,
    joinId: string,
    input: CollaborationJoinReconcileInput,
    signal?: AbortSignal,
  ) {
    CollaborationJoinSchema.shape.joinId.parse(joinId);
    return this.request(
      this.path(id, `joins/${joinId}/reconcile`),
      CollaborationJoinSchema,
      signal,
      {
        method: 'POST',
        body: CollaborationJoinReconcileInputSchema.parse(input),
      },
    );
  }
  /** No public dispatch until ordinary delivery is wired and qualified. */
  send(id: string, input: CollaborationMessageInput) {
    return this.request(this.path(id, 'messages'), CollaborationMessageSchema, undefined, {
      method: 'POST',
      body: CollaborationMessageInputSchema.parse(input),
    });
  }
}
