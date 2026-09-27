import { z } from 'zod';
import type { SessionArtifactMapping } from './symposium-session-artifacts.js';
import type { ConnectionSelection } from './symposium-personal-connections.js';
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
export const PersonalEvidenceSelection = z.strictObject({
  personalConnection: z.strictObject({
    connectionId: identifier,
    expectedRevision: z.number().int().positive(),
  }),
  sessionId: identifier,
  allowedRoles: z
    .array(z.enum(['implementer', 'coder', 'reviewer']))
    .min(1)
    .max(3),
});
export interface PersonalAdmissionProof {
  provider: { name: string; id: string; type: 'codex'; profileName: 'codex' };
  assertCurrent(): void;
}
/** Derive identity from the retained adapter and ready session ledger, never from
 * caller-supplied provider names or a same-name volume in another session. */
export async function collectPersonalAdmissionEvidence<T>(
  selection: unknown,
  deps: {
    capture(selection: ConnectionSelection): PersonalAdmissionProof;
    getReady(
      sessionId: string,
    ): SessionArtifactMapping | null | Promise<SessionArtifactMapping | null>;
    collect(selection: unknown): Promise<T>;
  },
): Promise<T> {
  const input = PersonalEvidenceSelection.parse(selection);
  const proof = deps.capture(input.personalConnection);
  proof.assertCurrent();
  const mapping = await deps.getReady(input.sessionId);
  if (!mapping || mapping.sessionId !== input.sessionId)
    throw Error('Ready session artifact mapping required');
  const identity = structuredClone(mapping);
  const candidate = await deps.collect({
    providerInstances: [{ ...proof.provider }],
    artifactVolume: { driver: 'podman', name: identity.volumeName },
    allowedRoles: input.allowedRoles,
    allowedAccountProviders: ['openai-codex'],
  });
  proof.assertCurrent();
  const current = await deps.getReady(input.sessionId);
  if (
    !current ||
    current.sessionId !== identity.sessionId ||
    current.volumeName !== identity.volumeName ||
    current.volumeGeneration !== identity.volumeGeneration
  )
    throw Error('Session artifact mapping changed');
  // The physical-volume read above is asynchronous; fence the slot again afterward.
  proof.assertCurrent();
  return candidate;
}
