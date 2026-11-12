import { z } from 'zod';
import { SessionRuntimeBindingV2Schema } from './session-runtime-binding.js';
const physicalIdentity = z.strictObject({
  dev: z.string(),
  ino: z.string(),
  uid: z.string(),
  mode: z.string(),
  nlink: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
/** Private server evidence. Public session metadata never projects this column. */
export const VertexAdcCustodySchema = z.strictObject({
  version: z.literal(1),
  project: z.string().min(1).max(256),
  region: z.string().min(1).max(128),
  adc: physicalIdentity
    .extend({ path: z.string().min(1).max(4096), parentDev: z.string(), parentIno: z.string() })
    .strict(),
});
export type VertexAdcCustodySnapshot = z.infer<typeof VertexAdcCustodySchema>;
const hostIdentity = z.strictObject({
  path: z.string().min(1).max(4096),
  dev: z.string(),
  ino: z.string(),
  uid: z.string(),
  mode: z.string(),
});
export const ClaudeSubscriptionCustodySchema = z.strictObject({
  kind: z.literal('claude-host-login'),
  version: z.literal(1),
  email: z.email(),
  planType: z.enum(['pro', 'max']),
  config: hostIdentity,
  executable: hostIdentity
    .extend({ size: z.string(), mtimeNs: z.string(), ctimeNs: z.string() })
    .strict(),
});
export type ClaudeSubscriptionCustodySnapshot = z.infer<typeof ClaudeSubscriptionCustodySchema>;
export const AnthropicApiCustodySchema = z.strictObject({
  kind: z.literal('anthropic-api-key'),
  version: z.literal(1),
  endpoint: z.url(),
  authentication: z.enum(['api-key', 'bearer']),
  credentialRef: z.strictObject({
    provider: z.literal('keychain'),
    service: z.string().min(1).max(256),
    account: z.string().min(1).max(256),
  }),
  credentialVersion: z.uuid(),
});
export const OrdinaryLocalVertexCustodySchema = z
  .strictObject({
    version: z.literal(1),
    sessionId: z.string().min(1).max(200),
    sdkSessionId: z.uuid(),
    authSessionId: z.string().min(1).max(200),
    initialCommandId: z.string().min(1).max(200),
    repositoryWorkspaceId: z.string().min(1).max(200),
    cwd: z.string().min(1).max(4096),
    binding: SessionRuntimeBindingV2Schema.refine(
      (binding) =>
        ['anthropic-vertex', 'anthropic-claude', 'anthropic-api'].includes(
          binding.account.provider,
        ) &&
        binding.harness.implementation === 'claude-sdk' &&
        binding.execution.location === 'local',
    ),
    credentialAuthority: z.union([
      VertexAdcCustodySchema,
      ClaudeSubscriptionCustodySchema,
      AnthropicApiCustodySchema,
    ]),
  })
  .refine(
    (custody) =>
      custody.binding.account.provider ===
      ('kind' in custody.credentialAuthority
        ? custody.credentialAuthority.kind === 'claude-host-login'
          ? 'anthropic-claude'
          : 'anthropic-api'
        : 'anthropic-vertex'),
    'Claude authentication must match the selected account',
  );
export type OrdinaryLocalVertexCustody = z.infer<typeof OrdinaryLocalVertexCustodySchema>;
