import type { ArtifactReaderAdmissionBindingV1 } from '@mitzo/protocol';

type ReaderAssertion = (binding: ArtifactReaderAdmissionBindingV1) => true;

/** A live owned host may be constructed before the trusted review owner is composed. */
export function createSymposiumReaderAuthorityBridge() {
  let assertion: ReaderAssertion | null = null;
  const authority = Object.freeze({
    assertAdmissionCurrent(binding: ArtifactReaderAdmissionBindingV1): true {
      if (!assertion) throw new Error('Sealed reader authority is unavailable');
      if (assertion(binding) !== true) throw new Error('Sealed reader authority denied');
      return true;
    },
  });
  return {
    authority,
    install(callback: ReaderAssertion): void {
      if (assertion) throw new Error('Sealed reader authority already installed');
      if (typeof callback !== 'function')
        throw new Error('Sealed reader authority callback required');
      assertion = callback;
    },
  };
}
