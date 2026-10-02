import { createHash } from 'node:crypto';
import type {
  ArtifactAdmissionBindingV1,
  ArtifactAdmissionReferenceV1,
} from './symposium-artifact-admission.js';
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (key) => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key]),
        )
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export function artifactAdmissionDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function artifactAdmissionReference(
  binding: ArtifactAdmissionBindingV1,
): ArtifactAdmissionReferenceV1 {
  return {
    version: 1,
    transitionId: binding.transitionId,
    artifactGenerationId: binding.childGenerationId,
    pointerRevision: binding.activatedPointerRevision,
    bindingDigest: artifactAdmissionDigest(binding),
  };
}
