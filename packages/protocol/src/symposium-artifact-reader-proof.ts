import { artifactAdmissionDigest } from './symposium-artifact-admission-proof.js';
import type {
  ArtifactReaderAdmissionBindingV1,
  ArtifactReaderReferenceV1,
} from './symposium-artifact-reader.js';
export function artifactReaderReference(
  binding: ArtifactReaderAdmissionBindingV1,
): ArtifactReaderReferenceV1 {
  return {
    version: 1,
    kind: 'sealed_reader',
    readerAdmissionId: binding.readerAdmissionId,
    artifactGenerationId: binding.artifactGenerationId,
    sealFenceId: binding.sealFenceId,
    bindingDigest: artifactAdmissionDigest(binding),
  };
}
