import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  NATIVE_PERMISSION_PROTOCOL_VERSION,
  NativeApprovalRequestSchema,
  NativeAutoReviewNotificationSchema,
  NativeGrantedPermissionProfileSchema,
  NativeServerRequestResolvedSchema,
  parseNativeApprovalResponse,
} from '../codex-native-permission-protocol.js';

const fixture = () =>
  JSON.parse(
    readFileSync(
      new URL('./fixtures/codex-native-permission-protocol-0.160.0.json', import.meta.url),
      'utf8',
    ),
  );

describe('pinned native permission protocol', () => {
  it('preserves the pin and every qualified request field including callback identity and scoped permissions', () => {
    const contract = fixture();
    expect(NATIVE_PERMISSION_PROTOCOL_VERSION).toBe(contract.provenance.version);
    for (const request of contract.requests)
      expect(NativeApprovalRequestSchema.parse(request)).toEqual(request);
  });

  it('rejects malformed identity, unqualified protocol fields and permission spelling', () => {
    const request = fixture().requests[0];
    for (const change of [
      { threadId: null },
      { turnId: 7 },
      { itemId: [] },
      { kind: 'shell' },
      { startedAtMs: 'yesterday' },
      { additionalPermissions: { network: null, file_system: { write: ['/tmp'] } } },
      { additionalPermissions: { network: null, fileSystem: { read: null, write: [7] } } },
    ])
      expect(
        NativeApprovalRequestSchema.safeParse({
          ...request,
          params: { ...request.params, ...change },
        }).success,
      ).toBe(false);
    expect(
      NativeApprovalRequestSchema.safeParse({
        ...request,
        method: 'item/permission/requestApproval',
      }).success,
    ).toBe(false);
  });

  it('keeps command acceptance separate from actual scoped permission grants', () => {
    const contract = fixture();
    for (const response of contract.responses)
      expect(parseNativeApprovalResponse(response.method, response.result)).toEqual(
        response.result,
      );
    expect(() =>
      parseNativeApprovalResponse('item/commandExecution/requestApproval', {
        permissions: { fileSystem: { read: null, write: ['/tmp'] } },
        scope: 'turn',
      }),
    ).toThrow();
    expect(() =>
      parseNativeApprovalResponse('item/permissions/requestApproval', { decision: 'accept' }),
    ).toThrow();
    expect(() =>
      parseNativeApprovalResponse('item/fileChange/requestApproval', {
        decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git'] } },
      }),
    ).toThrow();
    expect(() =>
      parseNativeApprovalResponse('item/permissions/requestApproval', {
        permissions: {},
        scope: 'forever',
      }),
    ).toThrow();
    expect(() => parseNativeApprovalResponse('unknown', {})).toThrow();
    expect(NativeGrantedPermissionProfileSchema.parse({})).toEqual({});
  });

  it('preserves upstream review identity, terminal outcomes and request resolution without making a grant', () => {
    for (const notification of fixture().reviews)
      expect(NativeAutoReviewNotificationSchema.parse(notification)).toEqual(notification);
    expect(
      NativeServerRequestResolvedSchema.parse({ threadId: 'thread', requestId: 'callback' }),
    ).toEqual({ threadId: 'thread', requestId: 'callback' });
    expect(
      NativeAutoReviewNotificationSchema.safeParse({
        method: 'item/autoApprovalReview/completed',
        params: { ...fixture().reviews[1].params, review: { status: 'accepted' } },
      }).success,
    ).toBe(false);
  });
});
