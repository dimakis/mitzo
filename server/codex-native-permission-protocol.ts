import { z } from 'zod';

/** Reduced wire contract generated/qualified against upstream rust-v0.160.0.
 * Validation is not authorization: the runtime owner must bind each request to
 * its account, process, thread, turn and exact RPC callback before responding.
 * See docs/features/codex-native-permission-protocol.md for provenance and gaps.
 */
export const NATIVE_PERMISSION_PROTOCOL_VERSION = '0.160.0';
export const NATIVE_APPROVAL_METHODS = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
] as const;
export type NativeApprovalMethod = (typeof NATIVE_APPROVAL_METHODS)[number];

const Path = z.string();
const RequestId = z.union([z.string(), z.number().int()]);
const SpecialPath = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('root') }),
  z.strictObject({ kind: z.literal('minimal') }),
  z.strictObject({ kind: z.literal('project_roots'), subpath: Path.nullable() }),
  z.strictObject({ kind: z.literal('tmpdir') }),
  z.strictObject({ kind: z.literal('slash_tmp') }),
  z.strictObject({ kind: z.literal('unknown'), path: Path, subpath: Path.nullable() }),
]);
export const NativeFileSystemEntrySchema = z.strictObject({
  path: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('path'), path: Path }),
    z.strictObject({ type: z.literal('glob_pattern'), pattern: z.string() }),
    z.strictObject({ type: z.literal('special'), value: SpecialPath }),
  ]),
  access: z.enum(['read', 'write', 'deny']),
});
const FileSystem = z.strictObject({
  read: z.array(Path).nullable(),
  write: z.array(Path).nullable(),
  globScanMaxDepth: z.number().int().nonnegative().optional(),
  entries: z.array(NativeFileSystemEntrySchema).optional(),
});
const Network = z.strictObject({ enabled: z.boolean().nullable() });
export const NativePermissionProfileSchema = z.strictObject({
  network: Network.nullable(),
  fileSystem: FileSystem.nullable(),
});
export const NativeGrantedPermissionProfileSchema = z.strictObject({
  network: Network.optional(),
  fileSystem: FileSystem.optional(),
});
export const NativeApprovalsReviewerSchema = z.enum(['user', 'auto_review', 'guardian_subagent']);
export const NativePermissionGrantScopeSchema = z.enum(['turn', 'session']);
const NetworkProtocol = z.enum(['http', 'https', 'socks5Tcp', 'socks5Udp']);
const NetworkAmendment = z.strictObject({ host: z.string(), action: z.enum(['allow', 'deny']) });
export const NativeCommandApprovalDecisionSchema = z.union([
  z.enum(['accept', 'acceptForSession', 'decline', 'cancel']),
  z.strictObject({
    acceptWithExecpolicyAmendment: z.strictObject({ execpolicy_amendment: z.array(z.string()) }),
  }),
  z.strictObject({
    applyNetworkPolicyAmendment: z.strictObject({ network_policy_amendment: NetworkAmendment }),
  }),
]);
export const NativeFileApprovalDecisionSchema = z.enum([
  'accept',
  'acceptForSession',
  'decline',
  'cancel',
]);
const Identity = {
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  startedAtMs: z.number().int(),
};
const CommandAction = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('read'), command: z.string(), name: z.string(), path: Path }),
  z.strictObject({ type: z.literal('listFiles'), command: z.string(), path: Path.nullable() }),
  z.strictObject({
    type: z.literal('search'),
    command: z.string(),
    query: z.string().nullable(),
    path: Path.nullable(),
  }),
  z.strictObject({ type: z.literal('unknown'), command: z.string() }),
]);
export const NativeCommandApprovalParamsSchema = z.strictObject({
  ...Identity,
  kind: z.enum(['command', 'writeStdin']),
  approvalId: z.string().nullish(),
  environmentId: z.string().nullable(),
  reason: z.string().nullish(),
  networkApprovalContext: z.strictObject({ host: z.string(), protocol: NetworkProtocol }).nullish(),
  command: z.string().nullish(),
  cwd: Path.nullish(),
  commandActions: z.array(CommandAction).nullish(),
  additionalPermissions: NativePermissionProfileSchema.nullish(),
  proposedExecpolicyAmendment: z.array(z.string()).nullish(),
  proposedNetworkPolicyAmendments: z.array(NetworkAmendment).nullish(),
  availableDecisions: z.array(NativeCommandApprovalDecisionSchema).nullish(),
});
export const NativeFileApprovalParamsSchema = z.strictObject({
  ...Identity,
  reason: z.string().nullish(),
  grantRoot: z.string().nullish(),
});
export const NativePermissionsApprovalParamsSchema = z.strictObject({
  ...Identity,
  environmentId: z.string().nullable(),
  cwd: Path,
  reason: z.string().nullable(),
  permissions: NativePermissionProfileSchema,
});
export const NativeApprovalRequestSchema = z.discriminatedUnion('method', [
  z.strictObject({
    method: z.literal(NATIVE_APPROVAL_METHODS[0]),
    id: RequestId,
    params: NativeCommandApprovalParamsSchema,
  }),
  z.strictObject({
    method: z.literal(NATIVE_APPROVAL_METHODS[1]),
    id: RequestId,
    params: NativeFileApprovalParamsSchema,
  }),
  z.strictObject({
    method: z.literal(NATIVE_APPROVAL_METHODS[2]),
    id: RequestId,
    params: NativePermissionsApprovalParamsSchema,
  }),
]);
export type NativeApprovalRequest = z.infer<typeof NativeApprovalRequestSchema>;
export type NativePermissionProfile = z.infer<typeof NativePermissionProfileSchema>;
export type NativeGrantedPermissionProfile = z.infer<typeof NativeGrantedPermissionProfileSchema>;
export const NativePermissionsApprovalResponseSchema = z.strictObject({
  permissions: NativeGrantedPermissionProfileSchema,
  scope: NativePermissionGrantScopeSchema,
  strictAutoReview: z.boolean().optional(),
});
export function parseNativeApprovalResponse(method: string, value: unknown) {
  switch (method) {
    case NATIVE_APPROVAL_METHODS[0]:
      return z.strictObject({ decision: NativeCommandApprovalDecisionSchema }).parse(value);
    case NATIVE_APPROVAL_METHODS[1]:
      return z.strictObject({ decision: NativeFileApprovalDecisionSchema }).parse(value);
    case NATIVE_APPROVAL_METHODS[2]:
      return NativePermissionsApprovalResponseSchema.parse(value);
    default:
      throw new Error('Unsupported native approval response method');
  }
}

export const NativeServerRequestResolvedSchema = z.strictObject({
  threadId: z.string(),
  requestId: RequestId,
});
const Review = z.strictObject({
  status: z.enum(['inProgress', 'approved', 'denied', 'timedOut', 'aborted']),
  riskLevel: z.enum(['low', 'medium', 'high', 'critical']).nullable(),
  userAuthorization: z.enum(['unknown', 'low', 'medium', 'high']).nullable(),
  rationale: z.string().nullable(),
});
const Source = z.enum(['shell', 'unifiedExec']);
const ReviewAction = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('command'), source: Source, command: z.string(), cwd: Path }),
  z.strictObject({
    type: z.literal('execve'),
    source: Source,
    program: z.string(),
    argv: z.array(z.string()),
    cwd: Path,
  }),
  z.strictObject({
    type: z.literal('writeStdin'),
    approvalId: z.string(),
    processId: z.string(),
    stdin: z.string(),
    cwd: Path,
  }),
  z.strictObject({ type: z.literal('applyPatch'), cwd: Path, files: z.array(Path) }),
  z.strictObject({
    type: z.literal('networkAccess'),
    target: z.string(),
    host: z.string(),
    protocol: NetworkProtocol,
    port: z.number().int(),
  }),
  z.strictObject({
    type: z.literal('mcpToolCall'),
    server: z.string(),
    toolName: z.string(),
    connectorId: z.string().nullable(),
    connectorName: z.string().nullable(),
    toolTitle: z.string().nullable(),
  }),
  z.strictObject({
    type: z.literal('requestPermissions'),
    reason: z.string().nullable(),
    permissions: NativePermissionProfileSchema,
  }),
]);
const ReviewIdentity = { threadId: z.string(), turnId: z.string(), startedAtMs: z.number().int() };
const ReviewParams = {
  ...ReviewIdentity,
  reviewId: z.string(),
  targetItemId: z.string().nullable(),
  review: Review,
  action: ReviewAction,
};
export const NativeAutoReviewNotificationSchema = z.discriminatedUnion('method', [
  z.strictObject({
    method: z.literal('item/autoApprovalReview/started'),
    params: z.strictObject(ReviewParams),
  }),
  z.strictObject({
    method: z.literal('item/autoApprovalReview/completed'),
    params: z.strictObject({
      ...ReviewParams,
      completedAtMs: z.number().int(),
      decisionSource: z.literal('agent'),
    }),
  }),
  z.strictObject({
    method: z.literal('autoApprovalReview/strictReviewRequired'),
    params: z.strictObject(ReviewIdentity),
  }),
]);
