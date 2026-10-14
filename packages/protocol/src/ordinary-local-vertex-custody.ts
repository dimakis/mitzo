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
export const OrdinaryLocalVertexCustodySchema = z.strictObject({
  version: z.literal(1),
  sessionId: z.string().min(1).max(200),
  sdkSessionId: z.uuid(),
  authSessionId: z.string().min(1).max(200),
  initialCommandId: z.string().min(1).max(200),
  repositoryWorkspaceId: z.string().min(1).max(200),
  cwd: z.string().min(1).max(4096),
  binding: SessionRuntimeBindingV2Schema.refine(
    (binding) =>
      binding.account.provider === 'anthropic-vertex' &&
      binding.harness.implementation === 'claude-sdk' &&
      binding.execution.location === 'local',
  ),
  credentialAuthority: VertexAdcCustodySchema,
});
export type OrdinaryLocalVertexCustody = z.infer<typeof OrdinaryLocalVertexCustodySchema>;
