import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CollaborationContractError, CollaborationInlineArtifactPinSchema } from '@mitzo/protocol';
import type { TelosArtifactStore, TelosArtifactMetadata } from './telos-artifact-store.js';

const pinSchema = CollaborationInlineArtifactPinSchema;
export type RetainedCollaborationArtifactPin = z.infer<typeof pinSchema>;
export interface RetainedCollaborationArtifact {
  artifactId: string;
  revision: number;
  sha256: string;
  itemId: string;
  filename: string;
  title: string;
  mediaType: 'application/octet-stream';
  retention: 'independent';
  provenance: Pick<TelosArtifactMetadata, 'sessionId' | 'sourceKind' | 'sourcePath'>;
  bytes: Uint8Array;
}
export interface RetainedCollaborationArtifactRead extends RetainedCollaborationArtifact {
  /** Synchronous local custody/public-eligibility check only, not live authorization. */
  assertCurrent(): void;
}
export interface RetainedCollaborationArtifactSource {
  read(pin: RetainedCollaborationArtifactPin): Promise<RetainedCollaborationArtifactRead>;
}
function changed(): never {
  throw new CollaborationContractError('snapshot_changed');
}
const maximumBytes = 512 * 1024;
/** Borrow the existing retained owner. Origin session identity is provenance only;
 * it neither grants access nor requires the original transcript to remain available.
 * The host authorizer must check current artifact/item/operator scope on every call.
 * Standalone artifacts and scoped source-capture packets are unsupported here.
 */
export function createRetainedCollaborationArtifactSource(deps: {
  store: TelosArtifactStore;
  authorizeArtifact(
    pin: RetainedCollaborationArtifactPin,
    metadata: TelosArtifactMetadata,
  ): Promise<void>;
}): RetainedCollaborationArtifactSource {
  return {
    async read(raw) {
      const pin = pinSchema.parse(raw);
      function metadata() {
        try {
          const current = deps.store.metadataForRevision(pin.artifactId, pin.revision);
          if (
            current.id !== pin.artifactId ||
            current.revision !== pin.revision ||
            current.sha256 !== pin.sha256 ||
            current.sourceKind === 'source_capture' ||
            !deps.store.userUploadAllowed(current.itemId)
          )
            changed();
          return current;
        } catch {
          changed();
        }
      }
      const original = metadata();
      // Privacy/access is checked before content size or bytes are exposed.
      await deps.authorizeArtifact(structuredClone(pin), structuredClone(original));
      if (!isDeepStrictEqual(metadata(), original)) changed();
      if (original.size > maximumBytes) throw new CollaborationContractError('capacity_refused');
      await deps.authorizeArtifact(structuredClone(pin), structuredClone(original));
      if (!isDeepStrictEqual(metadata(), original)) changed();
      function currentBytes() {
        if (!isDeepStrictEqual(metadata(), original)) changed();
        let artifact;
        try {
          artifact = deps.store.readBoundedRevision(pin.artifactId, pin.revision, maximumBytes);
        } catch {
          changed();
        }
        const { bytes, ...current } = artifact;
        if (
          !isDeepStrictEqual(current, original) ||
          bytes.byteLength !== original.size ||
          createHash('sha256').update(bytes).digest('hex') !== pin.sha256 ||
          !deps.store.userUploadAllowed(current.itemId)
        )
          changed();
        return bytes;
      }
      const bytes = currentBytes();
      return Object.freeze({
        ...pin,
        itemId: original.itemId,
        filename: original.filename,
        title: original.title,
        mediaType: 'application/octet-stream',
        retention: 'independent',
        provenance: {
          sessionId: original.sessionId,
          sourceKind: original.sourceKind,
          sourcePath: original.sourcePath,
        },
        bytes: Buffer.from(bytes),
        // Private pin/metadata never escape through the returned projection. No
        // await/callback occurs in this local renewal; actual save/dispatch still
        // requires its owning transaction and current authorization.
        assertCurrent() {
          currentBytes();
        },
      });
    },
  };
}
