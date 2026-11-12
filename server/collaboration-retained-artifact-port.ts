import { TelosArtifactStore } from './telos-artifact-store.js';
import { createRetainedCollaborationArtifactSource } from './collaboration-retained-artifact-source.js';
import type { CollaborationRetainedArtifactPort } from './collaboration-application-forwarding.js';

/** Borrows the configured canonical artifact owner without migrations or writes.
 * No path comes from a selector, prompt or model. The application closes this
 * read handle with its other ordinary collaboration resources. */
export function createCollaborationRetainedArtifactPort(
  dbPath: () => string,
): CollaborationRetainedArtifactPort {
  let store: TelosArtifactStore | undefined;
  let closed = false;
  return {
    source(assertAuthorized) {
      return {
        async read(pin) {
          assertAuthorized();
          if (closed) throw Error('Collaboration artifact reader is closed');
          // Context without a retained artifact does not open or require Telos.
          store ??= TelosArtifactStore.openReadOnly(dbPath());
          const owner = store;
          owner.assertCurrentRead();
          const saved = await createRetainedCollaborationArtifactSource({
            store: owner,
            authorizeArtifact: async () => {
              assertAuthorized();
              owner.assertCurrentRead();
            },
          }).read(pin);
          owner.assertCurrentRead();
          return Object.freeze({
            ...saved,
            assertCurrent() {
              assertAuthorized();
              owner.assertCurrentRead();
              saved.assertCurrent();
              owner.assertCurrentRead();
            },
          });
        },
      };
    },
    close() {
      closed = true;
      store?.close();
      store = undefined;
    },
  };
}
