import { createHash } from 'node:crypto';
import { z } from 'zod';
import { OrdinaryOpenShellCommandAdmissionSchema } from '@mitzo/protocol';
import type { ArtifactRuntime } from './codex-conversation-store.js';
/** Immutable native continuation custody in the existing conversation row. */
export const OpenShellCodexCustodySchema = z.strictObject({
  version: z.literal(1),
  authSessionId: z.string().min(1).max(200),
  binding: OrdinaryOpenShellCommandAdmissionSchema.shape.binding,
  workspace: OrdinaryOpenShellCommandAdmissionSchema.shape.workspace,
  physicalIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/),
  agentProfileSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  agentContextSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type OpenShellCodexCustody = z.infer<typeof OpenShellCodexCustodySchema>;
export function openShellPhysicalCustodyFingerprint(artifact: ArtifactRuntime) {
  const { resourceVersion: _version, created: _created, ...runtime } = artifact.runtime;
  const { model: _model, ...route } = artifact.route;
  void _version;
  void _created;
  void _model;
  // Stable field order across serialized/reopened native rows.
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : value;
  return createHash('sha256')
    .update(JSON.stringify(canonical({ runtime, route })))
    .digest('hex');
}
