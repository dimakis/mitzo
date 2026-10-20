import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { CollaborationContractError, CollaborationSnapshotSelectionSchema } from '@mitzo/protocol';
import type { TelosArtifactMetadata, TelosArtifactStore } from './telos-artifact-store.js';
import type { RetainedCollaborationArtifactSource } from './collaboration-retained-artifact-source.js';

/** Local integration seam until the shared joining schema consumes this tag.
 * Public selectors contain no item, association, privacy or retention authority. */
export const JoiningRetainedArtifactPinSchema =
  CollaborationSnapshotSelectionSchema.shape.artifacts.element.extend({
    kind: z.literal('retainedArtifactVersion'),
  });
export type JoiningRetainedArtifactPin = z.infer<typeof JoiningRetainedArtifactPinSchema>;
export interface JoiningRetainedArtifactMetadata extends JoiningRetainedArtifactPin {
  retention: 'independent';
  itemId: string;
  filename: string;
  title: string;
  provenance: Pick<TelosArtifactMetadata, 'sessionId' | 'sourceKind' | 'sourcePath'>;
  mediaType: 'application/octet-stream';
  sizeBytes: number;
}
export interface JoiningRetainedArtifact extends JoiningRetainedArtifactMetadata {
  contentBase64: string;
}
export interface JoiningRetainedArtifactAssociation {
  /** Core owns canonical origin-in-current-conversation or visible-prefix reference
   * authority. Selecting another exact revision must not imply a new association. */
  assertAssociated(pin: JoiningRetainedArtifactPin): Promise<void>;
  /** Renew the opened source/prefix and association synchronously at final save. */
  assertCurrent(pin: JoiningRetainedArtifactPin): void;
}
export interface JoiningRetainedArtifactAuthorization {
  authorize(pin: JoiningRetainedArtifactPin, metadata: TelosArtifactMetadata): Promise<void>;
  /** Genuine live artifact/item/operator authority, separate from byte custody. */
  assertCurrent(pin: JoiningRetainedArtifactPin, metadata: TelosArtifactMetadata): void;
}
const maximumBytes = 512 * 1024;
const pageOptions = z.strictObject({
  beforeRevision: z.number().int().positive().safe().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
function changed(): never {
  throw new CollaborationContractError('snapshot_changed');
}
function bounded(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maximumBytes)
    throw new CollaborationContractError('capacity_refused');
}
function synchronous(check: () => unknown) {
  const result = check();
  // A void function type also accepts async callbacks. They cannot hold the
  // local save fence; drain rejections without accepting their eventual result.
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => {});
    changed();
  }
}
export function joiningRetainedArtifactKey(raw: unknown) {
  const pin = JoiningRetainedArtifactPinSchema.parse(raw);
  return `${pin.kind}:${pin.artifactId}:${pin.revision}:${pin.sha256}`;
}

/** Host-only bridge over the existing immutable revision owner. This creates no
 * store, association, review, capacity, admission or dispatch authority. Core
 * supplies associated candidate seeds; there is deliberately no global search.
 */
export function createJoiningRetainedArtifacts(deps: {
  store: TelosArtifactStore;
  source: RetainedCollaborationArtifactSource;
  association: JoiningRetainedArtifactAssociation;
  authorization: JoiningRetainedArtifactAuthorization;
}) {
  const copy = (pin: JoiningRetainedArtifactPin) => structuredClone(pin);
  function sourceCurrent(pin: JoiningRetainedArtifactPin) {
    synchronous(() => deps.association.assertCurrent(copy(pin)));
  }
  function actual(pin: JoiningRetainedArtifactPin) {
    try {
      const metadata = deps.store.metadataForRevision(pin.artifactId, pin.revision);
      if (
        metadata.id !== pin.artifactId ||
        metadata.revision !== pin.revision ||
        metadata.sha256 !== pin.sha256 ||
        metadata.sourceKind === 'source_capture' ||
        !deps.store.userUploadAllowed(metadata.itemId) ||
        !Number.isSafeInteger(metadata.size) ||
        metadata.size < 0
      )
        changed();
      return metadata;
    } catch {
      changed();
    }
  }
  function projection(pin: JoiningRetainedArtifactPin, metadata: TelosArtifactMetadata) {
    const value: JoiningRetainedArtifactMetadata = {
      ...pin,
      retention: 'independent',
      itemId: metadata.itemId,
      filename: metadata.filename,
      title: metadata.title,
      provenance: Object.freeze({
        sessionId: metadata.sessionId,
        sourceKind: metadata.sourceKind,
        sourcePath: metadata.sourcePath,
      }),
      mediaType: 'application/octet-stream',
      sizeBytes: metadata.size,
    };
    bounded(value);
    return Object.freeze(value);
  }
  async function observe(pin: JoiningRetainedArtifactPin) {
    await deps.association.assertAssociated(copy(pin));
    sourceCurrent(pin);
    const original = structuredClone(actual(pin));
    // Real revision/privacy reads only: no supplied authority callback may run
    // in this final comparison, including when checking a whole metadata page.
    function assertMetadataCurrent() {
      if (!isDeepStrictEqual(actual(pin), original)) changed();
    }
    function assertCurrent() {
      sourceCurrent(pin);
      assertMetadataCurrent();
      synchronous(() => deps.authorization.assertCurrent(copy(pin), structuredClone(original)));
      // An authority callback must not be able to change custody during its check.
      sourceCurrent(pin);
      assertMetadataCurrent();
    }
    await deps.authorization.authorize(copy(pin), structuredClone(original));
    assertCurrent();
    return { original, assertCurrent, assertMetadataCurrent, value: projection(pin, original) };
  }
  return {
    async metadata(raw: unknown): Promise<JoiningRetainedArtifactMetadata> {
      const pin = JoiningRetainedArtifactPinSchema.parse(raw);
      const observed = await observe(pin);
      observed.assertCurrent();
      return observed.value;
    },
    async read(raw: unknown): Promise<{
      artifact: JoiningRetainedArtifact;
      /** Invoke inside the core owner's synchronous persistence fence. This is
       * not an acknowledgement that any join or delivery has occurred. */
      assertCurrent(): void;
    }> {
      const pin = JoiningRetainedArtifactPinSchema.parse(raw);
      const observed = await observe(pin);
      observed.assertCurrent();
      if (observed.original.size > maximumBytes)
        throw new CollaborationContractError('capacity_refused');
      const retained = await deps.source.read({
        artifactId: pin.artifactId,
        revision: pin.revision,
        sha256: pin.sha256,
      });
      observed.assertCurrent();
      if (
        retained.artifactId !== pin.artifactId ||
        retained.revision !== pin.revision ||
        retained.sha256 !== pin.sha256 ||
        retained.retention !== 'independent' ||
        retained.itemId !== observed.value.itemId ||
        retained.filename !== observed.value.filename ||
        retained.title !== observed.value.title ||
        retained.mediaType !== observed.value.mediaType ||
        !isDeepStrictEqual(retained.provenance, observed.value.provenance) ||
        retained.bytes.byteLength !== observed.original.size ||
        createHash('sha256').update(retained.bytes).digest('hex') !== pin.sha256 ||
        typeof retained.assertCurrent !== 'function'
      )
        changed();
      const custody = retained.assertCurrent.bind(retained);
      const artifact = Object.freeze({
        ...observed.value,
        contentBase64: Buffer.from(retained.bytes).toString('base64'),
      });
      bounded(artifact);
      function assertCurrent() {
        observed.assertCurrent();
        synchronous(custody);
        observed.assertCurrent();
        // The existing retained owner's currentBytes renewal is callback-free:
        // it rereads bounded bytes, exact metadata, hash and public eligibility.
        // Finish there so the last authority callback cannot replace equal-size
        // bytes after the last hash check. Core still owns atomic access/save.
        synchronous(custody);
      }
      await deps.association.assertAssociated(copy(pin));
      assertCurrent();
      await deps.authorization.authorize(copy(pin), structuredClone(observed.original));
      assertCurrent();
      return Object.freeze({ artifact, assertCurrent });
    },
    /** Metadata-only keyset paging for an already associated artifact. Core owns
     * candidate enumeration and chooses exact actual references for So far;
     * this method never adds latest/all revisions to a joining selection. */
    async revisionPage(raw: unknown, rawOptions: unknown = {}) {
      const pin = JoiningRetainedArtifactPinSchema.parse(raw);
      const options = pageOptions.parse(rawOptions);
      const seed = await observe(pin);
      seed.assertCurrent();
      const page = deps.store.revisionPage(pin.artifactId, options);
      if (page.artifacts.length > (options.limit ?? 50)) changed();
      const observations = [seed];
      let previous = options.beforeRevision ?? Number.POSITIVE_INFINITY;
      for (const metadata of page.artifacts) {
        if (metadata.id !== pin.artifactId || metadata.revision >= previous) changed();
        previous = metadata.revision;
        const version = JoiningRetainedArtifactPinSchema.parse({
          kind: pin.kind,
          artifactId: metadata.id,
          revision: metadata.revision,
          sha256: metadata.sha256,
        });
        const observed = await observe(version);
        if (!isDeepStrictEqual(observed.original, metadata)) changed();
        observations.push(observed);
      }
      if (page.cursor !== (page.hasMore ? page.artifacts.at(-1)?.revision : null)) changed();
      const result = {
        artifacts: observations.slice(1).map((item) => item.value),
        cursor: page.cursor,
        hasMore: page.hasMore,
      };
      bounded(result);
      observations.forEach((item) => item.assertCurrent());
      // A late entry's synchronous callback may change an earlier entry. Finish
      // the entire page with real metadata comparisons, without more callbacks
      // or content hydration after any of these final comparisons.
      observations.forEach((item) => item.assertMetadataCurrent());
      return result;
    },
  };
}
