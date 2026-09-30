import type { ArtifactReaderAdmissionBindingV1 } from '@mitzo/protocol';

type ReaderAssertion = (binding: ArtifactReaderAdmissionBindingV1) => true;

/** A live owned host may be constructed before the trusted review owner is composed. */
export function createSymposiumReaderAuthorityBridge() {
  let assertions: { current: ReaderAssertion; staged: ReaderAssertion } | null = null;
  const authority = Object.freeze({
    assertAdmissionCurrent(binding: ArtifactReaderAdmissionBindingV1): true {
      if (!assertions) throw new Error('Sealed reader authority is unavailable');
      if (assertions.current(binding) !== true) throw new Error('Sealed reader authority denied');
      return true;
    },
    assertAdmissionStaged(binding: ArtifactReaderAdmissionBindingV1): true {
      if (!assertions) throw new Error('Sealed reader authority is unavailable');
      if (assertions.staged(binding) !== true) throw new Error('Staged reader authority denied');
      return true;
    },
  });
  return {
    authority,
    install(callbacks: { current: ReaderAssertion; staged: ReaderAssertion }): void {
      if (assertions) throw new Error('Sealed reader authority already installed');
      if (typeof callbacks?.current !== 'function' || typeof callbacks.staged !== 'function')
        throw new Error('Sealed reader authority callbacks required');
      assertions = callbacks;
    },
  };
}
