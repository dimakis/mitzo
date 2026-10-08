/** Fixed worker phases; never carry exception text or caller supplied paths across this boundary. */
export const OWNED_EVIDENCE_PHASES = [
  'physical-init',
  'selection',
  'custody',
  'custody-native',
  'custody-driver',
  'custody-claude',
  'local-inputs',
  'profile-export',
  'gate',
  'verify-image',
  'verify-native-artifacts',
  'verify-profile',
  'verify-provider',
  'verify-driver',
  'verify-volume',
] as const;

export type OwnedEvidencePhase = (typeof OWNED_EVIDENCE_PHASES)[number];

export function ownedEvidencePhase(value: unknown): OwnedEvidencePhase | undefined {
  return typeof value === 'string' && (OWNED_EVIDENCE_PHASES as readonly string[]).includes(value)
    ? (value as OwnedEvidencePhase)
    : undefined;
}

export class OwnedEvidenceVerificationError extends Error {
  constructor(readonly phase?: OwnedEvidencePhase) {
    super('Evidence could not be verified');
  }
}
