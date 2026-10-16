import {
  TelosWorkCommandSchema,
  TelosWorkViewSchema,
  TelosWorkCommandReceiptSchema,
  TelosSourceConversationReferenceSchema,
  TelosConversationWorkLinksSchema,
  TelosWorkIdSchema,
  TelosWorkItemSchema,
  TelosSourcePreviewRequestSchema,
  TelosSourcePreviewSchema,
  TelosSourceAdoptRequestSchema,
  TelosReviewedSourceViewSchema,
  type TelosSourcePreviewRequest,
  type TelosSourceAdoptRequest,
  type TelosWorkCommand,
  type TelosWorkSessionLink,
} from '@mitzo/protocol';
import type { ApiFetch } from './api-client.js';

export class TelosWorkApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
/** Explicit reads and commands. No allocation, implicit retries, model turn or
 * setting changes. Callers retain their original request ID on uncertain results.
 */
export class TelosWorkApiClient {
  constructor(private readonly fetch: ApiFetch) {}
  private async request<T>(
    path: string,
    schema: { parse(value: unknown): T },
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.fetch('/api/telos/work/' + path, {
      credentials: 'include',
      signal,
      ...(body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new TelosWorkApiError(
        response.status,
        typeof error?.code === 'string' ? error.code : 'unavailable',
        typeof error?.error === 'string' ? error.error : 'Telos work unavailable',
      );
    }
    return schema.parse(await response.json());
  }
  read(itemId: string, signal?: AbortSignal) {
    const id = TelosWorkIdSchema.parse(itemId);
    if (/[\\/?#]/.test(id)) return Promise.reject(new Error('Invalid work item ID'));
    return this.request('items/' + encodeURIComponent(id), TelosWorkViewSchema, undefined, signal);
  }
  readRecord(itemId: string, signal?: AbortSignal) {
    const id = TelosWorkIdSchema.parse(itemId);
    if (/[\\/?#]/.test(id)) return Promise.reject(new Error('Invalid work item ID'));
    return this.request(
      'items/' + encodeURIComponent(id) + '/record',
      TelosWorkItemSchema,
      undefined,
      signal,
    );
  }
  async previewSource(input: TelosSourcePreviewRequest, signal?: AbortSignal) {
    return this.request(
      'source/preview',
      TelosSourcePreviewSchema,
      TelosSourcePreviewRequestSchema.parse(input),
      signal,
    );
  }
  async adoptSource(input: TelosSourceAdoptRequest) {
    return this.request(
      'source/adopt',
      TelosWorkCommandReceiptSchema,
      TelosSourceAdoptRequestSchema.parse(input),
    );
  }
  readSource(itemId: string, snapshotId: string, signal?: AbortSignal) {
    const item = TelosWorkIdSchema.parse(itemId),
      snapshot = TelosWorkIdSchema.parse(snapshotId);
    if (/[\\/?#]/.test(item) || /[\\/?#]/.test(snapshot))
      return Promise.reject(new Error('Invalid source reference'));
    return this.request(
      'items/' + encodeURIComponent(item) + '/sources/' + encodeURIComponent(snapshot),
      TelosReviewedSourceViewSchema,
      undefined,
      signal,
    );
  }
  execute(input: TelosWorkCommand) {
    return this.request(
      'commands',
      TelosWorkCommandReceiptSchema,
      TelosWorkCommandSchema.parse(input),
    );
  }
  links(input: TelosWorkSessionLink['conversation'], signal?: AbortSignal) {
    return this.request(
      'links',
      TelosConversationWorkLinksSchema,
      TelosSourceConversationReferenceSchema.parse(input),
      signal,
    );
  }
}
