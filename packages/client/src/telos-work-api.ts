import {
  TelosWorkControlCommandSchema,
  TelosWorkControlResultSchema,
  type TelosWorkControlCommand,
  TelosOrdinaryWorkRoleSetupInputSchema,
  TelosOrdinaryWorkReviewedRoleSetupInputSchema,
  TelosOrdinaryWorkDelegationInputSchema,
  type TelosOrdinaryWorkRoleSetupInput,
  type TelosOrdinaryWorkReviewedRoleSetupInput,
  type TelosOrdinaryWorkDelegationInput,
} from '@mitzo/protocol';
import {
  TelosSourcePermissionReviewSchema,
  TelosSourceMaterialPageRequestSchema,
  TelosSourceMaterialPageSchema,
  type TelosSourceMaterialPageRequest,
  TelosSourcePermissionPreviewRequestSchema,
  TelosSourcePermissionPreviewSchema,
  TelosSourcePermissionApproveRequestSchema,
  TelosSourcePermissionReceiptSchema,
  type TelosSourcePermissionPreviewRequest,
  type TelosSourcePermissionApproveRequest,
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
  TelosSourceNewPreviewRequestSchema,
  TelosSourceCreateRequestSchema,
  type TelosSourceNewPreviewRequest,
  type TelosSourceCreateRequest,
  type TelosWorkCommand,
  type TelosWorkSessionLink,
  type TelosWorkRoleSetupInput,
  type TelosWorkCommandReceipt,
  TelosWorkRoleContextRequestSchema,
  TelosWorkRoleContextSelectionSchema,
  TelosWorkRoleSetupInputSchema,
  TelosWorkRoleSetupRecoverySchema,
  TelosWorkRoleContextReviewSchema,
  TelosWorkReviewedRoleSetupInputSchema,
  type TelosWorkReviewedRoleSetupInput,
  type TelosWorkRoleSetupRecovery,
  type TelosWorkRoleContextRequest,
  TelosWorkAdvisorDraftPreviewRequestSchema,
  TelosWorkAdvisorDraftSaveRequestSchema,
  type TelosWorkAdvisorDraftPreviewRequest,
  type TelosWorkAdvisorDraftSaveRequest,
  TelosWorkDelegationInputSchema,
  TelosWorkDelegationReceiptSchema,
  type TelosWorkDelegationInput,
  type TelosWorkDelegationReceipt,
} from '@mitzo/protocol';
import type { ApiFetch } from './api-client.js';

export class TelosWorkApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly recovery?: TelosWorkRoleSetupRecovery,
  ) {
    super(message);
  }
}
/** Explicit reads and commands, including reviewed worker provisioning. No hidden
 * retries, model turn or setting changes. Retain request IDs on uncertain results.
 */
export class TelosWorkApiClient {
  constructor(private readonly fetch: ApiFetch) {}
  /** Human request/read/release only. Recipient ACK and host evidence keep
   * their existing native/internal owners; uncertain commands are not retried. */
  async control(
    command: Exclude<TelosWorkControlCommand, { operation: 'acknowledge' }>,
    signal?: AbortSignal,
  ) {
    const input = TelosWorkControlCommandSchema.parse(command);
    if (input.operation === 'acknowledge')
      throw new TelosWorkApiError(
        403,
        'unauthorized',
        'Acknowledgement requires the current recipient conversation',
      );
    const result = await this.request('controls', TelosWorkControlResultSchema, command, signal);
    const mismatch =
      (input.operation === 'inbox') !== Array.isArray(result) ||
      (!Array.isArray(result) &&
        (input.operation === 'request'
          ? result.coordinatorItemId !== input.coordinatorItemId ||
            result.priorityItemId !== input.priorityItemId ||
            result.scope !== input.scope
          : 'controlId' in input && result.controlId !== input.controlId));
    if (mismatch)
      throw new TelosWorkApiError(
        502,
        'invalid',
        'Scoped control receipt differs from the selected operation',
      );
    return result;
  }
  setupOrdinaryRole(
    input: TelosOrdinaryWorkRoleSetupInput,
    signal?: AbortSignal,
  ): Promise<TelosWorkCommandReceipt> {
    return this.request(
      'roles/ordinary/setup',
      TelosWorkCommandReceiptSchema,
      TelosOrdinaryWorkRoleSetupInputSchema.parse(input),
      signal,
    );
  }
  setupReviewedOrdinaryRole(
    input: TelosOrdinaryWorkReviewedRoleSetupInput,
    signal?: AbortSignal,
  ): Promise<TelosWorkCommandReceipt> {
    return this.request(
      'roles/ordinary/setup-reviewed',
      TelosWorkCommandReceiptSchema,
      TelosOrdinaryWorkReviewedRoleSetupInputSchema.parse(input),
      signal,
    );
  }
  delegateOrdinarySlice(
    input: TelosOrdinaryWorkDelegationInput,
    signal?: AbortSignal,
  ): Promise<TelosWorkDelegationReceipt> {
    return this.request(
      'delegation/ordinary/start',
      TelosWorkDelegationReceiptSchema,
      TelosOrdinaryWorkDelegationInputSchema.parse(input),
      signal,
    );
  }
  delegateSlice(
    input: TelosWorkDelegationInput,
    signal?: AbortSignal,
  ): Promise<TelosWorkDelegationReceipt> {
    return this.request(
      'delegation/start',
      TelosWorkDelegationReceiptSchema,
      TelosWorkDelegationInputSchema.parse(input),
      signal,
    );
  }
  previewAdvisorDraft(input: TelosWorkAdvisorDraftPreviewRequest, signal?: AbortSignal) {
    return this.request(
      'advisor/preview',
      TelosSourcePreviewSchema,
      TelosWorkAdvisorDraftPreviewRequestSchema.parse(input),
      signal,
    );
  }
  saveAdvisorDraft(input: TelosWorkAdvisorDraftSaveRequest) {
    return this.request(
      'advisor/save',
      TelosWorkCommandReceiptSchema,
      TelosWorkAdvisorDraftSaveRequestSchema.parse(input),
    );
  }
  reviewRoleContext(input: TelosWorkRoleContextRequest, signal?: AbortSignal) {
    return this.request(
      'roles/review',
      TelosWorkRoleContextReviewSchema,
      TelosWorkRoleContextRequestSchema.parse(input),
      signal,
    );
  }
  setupReviewedRole(
    input: TelosWorkReviewedRoleSetupInput,
    signal?: AbortSignal,
  ): Promise<TelosWorkCommandReceipt> {
    return this.request(
      'roles/setup-reviewed',
      TelosWorkCommandReceiptSchema,
      TelosWorkReviewedRoleSetupInputSchema.parse(input),
      signal,
    );
  }
  roleContext(input: TelosWorkRoleContextRequest, signal?: AbortSignal) {
    return this.request(
      'roles/context',
      TelosWorkRoleContextSelectionSchema,
      TelosWorkRoleContextRequestSchema.parse(input),
      signal,
    );
  }
  setupRole(
    input: TelosWorkRoleSetupInput,
    signal?: AbortSignal,
  ): Promise<TelosWorkCommandReceipt> {
    return this.request(
      'roles/setup',
      TelosWorkCommandReceiptSchema,
      TelosWorkRoleSetupInputSchema.parse(input),
      signal,
    );
  }
  getSourcePermission(permId: string, sessionId: string, signal?: AbortSignal, afterSequence = 0) {
    return this.request(
      'source/permissions/' +
        encodeURIComponent(TelosWorkIdSchema.parse(permId)) +
        '?' +
        new URLSearchParams({
          sessionId: TelosWorkIdSchema.parse(sessionId),
          afterSequence: String(afterSequence),
        }),
      TelosSourcePermissionReviewSchema,
      undefined,
      signal,
    );
  }
  getSourceMaterials(permId: string, raw: TelosSourceMaterialPageRequest, signal?: AbortSignal) {
    const input = TelosSourceMaterialPageRequestSchema.parse(raw);
    const query = new URLSearchParams({
      sessionId: input.sessionId,
      toolUseId: input.toolUseId,
      proposalSha256: input.proposalSha256,
    });
    if (input.after) query.set('after', JSON.stringify(input.after));
    return this.request(
      'source/permissions/' +
        encodeURIComponent(TelosWorkIdSchema.parse(permId)) +
        '/materials?' +
        query,
      TelosSourceMaterialPageSchema,
      undefined,
      signal,
    );
  }
  previewSourcePermission(
    permId: string,
    input: TelosSourcePermissionPreviewRequest,
    signal?: AbortSignal,
  ) {
    return this.request(
      'source/permissions/' + encodeURIComponent(TelosWorkIdSchema.parse(permId)) + '/preview',
      TelosSourcePermissionPreviewSchema,
      TelosSourcePermissionPreviewRequestSchema.parse(input),
      signal,
    );
  }
  approveSourcePermission(permId: string, input: TelosSourcePermissionApproveRequest) {
    return this.request(
      'source/permissions/' + encodeURIComponent(TelosWorkIdSchema.parse(permId)) + '/approve',
      TelosSourcePermissionReceiptSchema,
      TelosSourcePermissionApproveRequestSchema.parse(input),
    );
  }
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
      const code = typeof error?.code === 'string' ? error.code : 'unavailable';
      const parsed = TelosWorkRoleSetupRecoverySchema.safeParse(error?.recovery);
      const candidate =
        ['roles/setup-reviewed', 'roles/ordinary/setup-reviewed'].includes(path) &&
        body &&
        typeof body === 'object' &&
        'input' in body
          ? body.input
          : body;
      const requestId =
        candidate && typeof candidate === 'object' && 'requestId' in candidate
          ? candidate.requestId
          : undefined;
      const recovery =
        [
          'roles/setup',
          'roles/setup-reviewed',
          'roles/ordinary/setup',
          'roles/ordinary/setup-reviewed',
        ].includes(path) &&
        parsed.success &&
        parsed.data.requestId === requestId &&
        (parsed.data.outcome === 'recover_original' ||
          (response.status === 409 && code === 'conflict'))
          ? parsed.data
          : undefined;
      throw new TelosWorkApiError(
        response.status,
        code,
        typeof error?.error === 'string' ? error.error : 'Telos work unavailable',
        recovery,
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
  async previewOutcomeSource(input: TelosSourceNewPreviewRequest, signal?: AbortSignal) {
    return this.request(
      'source/outcome/preview',
      TelosSourcePreviewSchema,
      TelosSourceNewPreviewRequestSchema.parse(input),
      signal,
    );
  }
  async createOutcomeFromSource(input: TelosSourceCreateRequest) {
    return this.request(
      'source/outcome/create',
      TelosWorkCommandReceiptSchema,
      TelosSourceCreateRequestSchema.parse(input),
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
