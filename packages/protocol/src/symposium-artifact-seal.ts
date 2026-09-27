import { z } from 'zod';
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Internal host intent only. None of these fields assert physical quiescence. */
export const SymposiumArtifactSealSelectionSchema = z.strictObject({
  sessionId: id,
  expectedConfigRevision: z.number().int().positive(),
  idempotencyKey: id,
  custody: z.strictObject({ workspaceId: id, gatewayLaunchDigest: digest }),
  artifact: z.strictObject({
    driver: z.literal('podman'),
    volumeName: id,
    volumeGeneration: id,
    leaseRevision: id,
    leaseTokenHash: digest,
  }),
});
export type SymposiumArtifactSealSelection = z.infer<typeof SymposiumArtifactSealSelectionSchema>;
export interface SymposiumArtifactSealIntent {
  kind: 'artifact_seal_intent';
  status: 'pending_unsealed';
  version: 1;
  fenceId: string;
  selection: SymposiumArtifactSealSelection;
  configDigest: string;
  memberships: Array<{
    seatId: string;
    generation: number;
    state: string;
    reconciliation: string;
    bindingDigest: string;
  }>;
  capturedAt: number;
}
