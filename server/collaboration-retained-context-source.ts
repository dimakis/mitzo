import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  CollaborationContractError,
  CollaborationRetainedArtifactMetadataSchema,
  CollaborationRetainedArtifactPinSchema,
  type CollaborationSnapshotSelection,
} from '@mitzo/protocol';
import { createJoiningRetainedArtifacts } from './collaboration-joining-retained-artifacts.js';
import { createRetainedCollaborationArtifactSource } from './collaboration-retained-artifact-source.js';
import { telosMaterialDestinations } from './telos-source-materials.js';
import type { EventStore } from './event-store.js';
import type { TelosArtifactMetadata, TelosArtifactStore } from './telos-artifact-store.js';

type Pin = ReturnType<typeof CollaborationRetainedArtifactPinSchema.parse>;
type Reference = { artifactId: string; revision: number | null; sequence: number };
const maximumBytes = 512 * 1024;
const key = (pin: { artifactId: string; revision: number }) => `${pin.artifactId}:${pin.revision}`;
function changed(): never {
  throw new CollaborationContractError('snapshot_changed');
}
function overflow(): never {
  throw new CollaborationContractError('capacity_refused');
}

/** Borrows the actual opened EventStore prefix and retained revision owner. No
 * association registry, item search, Work inheritance or origin-transcript read.
 * Origin is a metadata relation; a visible link associates only its artifact ID.
 */
export function createCollaborationRetainedContext(deps: {
  source: ReturnType<EventStore['openCollaborationVisibleSource']>;
  artifacts?: TelosArtifactStore;
  authorize(): Promise<void>;
  assertSourceCurrent(): void;
}) {
  let references: Reference[] | undefined;
  const exact = new Map<string, Pin>();
  const metadataReads = new Map<string, { pin: Pin; metadata: TelosArtifactMetadata }>();
  const reads = new Map<
    string,
    {
      pin: Pin;
      metadata: TelosArtifactMetadata;
      bytes: number;
      assertCurrent(): void;
    }
  >();
  const requireStore = () => {
    if (!deps.artifacts) throw new CollaborationContractError('execution_unavailable');
    return deps.artifacts;
  };
  function visibleReferences() {
    if (references) return references;
    // This complete canonical witness excludes reasoning, tools and provider
    // history. Narrow origin-associated selections need not scan this prefix.
    deps.source.readPrefixWitness();
    const found: Reference[] = [];
    let after = 0;
    for (let pages = 0; ; pages++) {
      if (pages === 1000) overflow();
      const page = deps.source.readPage(after, 50);
      for (const message of page.messages)
        for (const block of message.blocks) {
          for (const destination of telosMaterialDestinations(block.content)) {
            const [path, revision] = destination.split('?revision=');
            const number = revision === undefined ? null : Number(revision);
            if (number !== null && (!Number.isSafeInteger(number) || number < 1)) changed();
            found.push({
              artifactId: path.slice(path.lastIndexOf('/') + 1),
              revision: number,
              sequence: message.sequence,
            });
            // Bound parser output separately from the 100 unique selected
            // versions. Repeated links in a bounded prefix are not new artifacts.
            if (found.length > 10_000) overflow();
          }
        }
      if (!page.hasMore) break;
      if (page.throughSequence <= after) changed();
      after = page.throughSequence;
    }
    deps.source.assertCurrent();
    references = found;
    return found;
  }
  function assertAssociated(pin: Pin) {
    const store = requireStore();
    if (
      !store.hasConversationOrigin(
        pin.artifactId,
        pin.revision,
        deps.source.sourceConversationId,
      ) &&
      !visibleReferences().some((ref) => ref.artifactId === pin.artifactId)
    )
      changed();
  }
  const bridge =
    deps.artifacts &&
    createJoiningRetainedArtifacts({
      store: deps.artifacts,
      source: createRetainedCollaborationArtifactSource({
        store: deps.artifacts,
        authorizeArtifact: async () => deps.authorize(),
      }),
      association: {
        async assertAssociated(pin) {
          await deps.authorize();
          assertAssociated(pin);
        },
        assertCurrent(pin) {
          deps.assertSourceCurrent();
          assertAssociated(pin);
        },
      },
      authorization: {
        async authorize() {
          await deps.authorize();
        },
        assertCurrent() {
          deps.assertSourceCurrent();
        },
      },
    });
  function assertOwned(metadata: TelosArtifactMetadata, pin: Pin, bytes: boolean) {
    const store = requireStore();
    if (
      !isDeepStrictEqual(store.metadataForRevision(pin.artifactId, pin.revision), metadata) ||
      metadata.sourceKind === 'source_capture' ||
      !store.userUploadAllowed(metadata.itemId)
    )
      changed();
    if (bytes) {
      const current = store.readBoundedRevision(pin.artifactId, pin.revision, maximumBytes);
      const { bytes: content, ...actualMetadata } = current;
      if (
        !isDeepStrictEqual(actualMetadata, metadata) ||
        content.byteLength !== metadata.size ||
        createHash('sha256').update(content).digest('hex') !== pin.sha256 ||
        !store.userUploadAllowed(metadata.itemId)
      )
        changed();
    }
  }
  async function metadata(raw: unknown) {
    const pin = CollaborationRetainedArtifactPinSchema.parse(raw);
    if (!bridge) {
      requireStore();
      changed();
    }
    const value = CollaborationRetainedArtifactMetadataSchema.parse(await bridge.metadata(pin));
    const owned = requireStore().metadataForRevision(pin.artifactId, pin.revision);
    if (
      !isDeepStrictEqual(value, {
        ...pin,
        retention: 'independent',
        itemId: owned.itemId,
        filename: owned.filename,
        title: owned.title,
        provenance: {
          sessionId: owned.sessionId,
          sourceKind: owned.sourceKind,
          sourcePath: owned.sourcePath,
        },
        mediaType: 'application/octet-stream',
        sizeBytes: owned.size,
      })
    )
      changed();
    assertOwned(owned, pin, false);
    const previous = metadataReads.get(key(pin));
    if (
      previous &&
      (!isDeepStrictEqual(previous.pin, pin) || !isDeepStrictEqual(previous.metadata, owned))
    )
      changed();
    metadataReads.set(key(pin), { pin, metadata: structuredClone(owned) });
    if (metadataReads.size > 300) overflow();
    return value;
  }
  return {
    /** Metadata only. Candidates come from the real origin relation or visible links. */
    metadata,
    unversionedReferences() {
      return visibleReferences().some((reference) => reference.revision === null);
    },
    async catalog(after?: Parameters<TelosArtifactStore['sourceMaterialPage']>[1]) {
      const store = requireStore();
      const page = store.sourceMaterialPage(deps.source.sourceConversationId, after);
      const values = new Map<string, Awaited<ReturnType<typeof metadata>>>();
      for (const row of page.artifacts) {
        const value = await metadata({
          kind: 'retainedArtifactVersion',
          artifactId: row.id,
          revision: row.revision,
          sha256: row.sha256,
        });
        values.set(key(value), value);
      }
      let unversionedReferences = false;
      const seenReferences = new Set<string>();
      for (const ref of visibleReferences()) {
        if (ref.revision === null) {
          unversionedReferences = true;
          continue;
        }
        if (seenReferences.has(key({ artifactId: ref.artifactId, revision: ref.revision })))
          continue;
        seenReferences.add(key({ artifactId: ref.artifactId, revision: ref.revision }));
        if (seenReferences.size > 100) overflow();
        const row = store.metadataForRevision(ref.artifactId, ref.revision);
        const value = await metadata({
          kind: 'retainedArtifactVersion',
          artifactId: row.id,
          revision: row.revision,
          sha256: row.sha256,
        });
        values.set(key(value), value);
      }
      return {
        artifacts: [...values.values()],
        cursor: page.hasMore ? page.cursor : null,
        hasMore: page.hasMore,
        unversionedReferences,
      };
    },
    async revisionPage(
      raw: unknown,
      options: Parameters<NonNullable<typeof bridge>['revisionPage']>[1] = {},
    ) {
      if (!bridge) {
        requireStore();
        changed();
      }
      await metadata(raw);
      const page = await bridge.revisionPage(raw, options);
      const artifacts = [];
      for (const value of page.artifacts)
        artifacts.push(
          await metadata({
            kind: value.kind,
            artifactId: value.artifactId,
            revision: value.revision,
            sha256: value.sha256,
          }),
        );
      return { ...page, artifacts };
    },
    async prepare(mode: CollaborationSnapshotSelection['mode']) {
      if (mode !== 'conversation_so_far') return;
      for (const reference of visibleReferences()) {
        if (reference.revision === null) changed(); // Never substitute latest for an unversioned link.
        const store = requireStore();
        if (!bridge) changed();
        const metadata = store.metadataForRevision(reference.artifactId, reference.revision);
        const pin = CollaborationRetainedArtifactPinSchema.parse({
          kind: 'retainedArtifactVersion',
          artifactId: metadata.id,
          revision: metadata.revision,
          sha256: metadata.sha256,
        });
        const previous = exact.get(key(pin));
        if (previous) {
          if (!isDeepStrictEqual(previous, pin)) changed();
          continue;
        }
        if (exact.size === 100) overflow();
        await bridge.metadata(pin);
        exact.set(key(pin), pin);
      }
      deps.source.assertCurrent();
    },
    pins(after = 0, through = deps.source.boundary.sequence): Pin[] {
      const result = new Map<string, Pin>();
      for (const ref of references ?? [])
        if (ref.sequence > after && ref.sequence <= through && ref.revision !== null) {
          const pin = exact.get(key({ artifactId: ref.artifactId, revision: ref.revision }));
          if (pin) result.set(key(pin), pin);
        }
      return structuredClone([...result.values()]);
    },
    async authorize(raw: unknown) {
      const pin = CollaborationRetainedArtifactPinSchema.parse(raw);
      if (!bridge) {
        requireStore();
        changed();
      }
      await bridge.metadata(pin);
    },
    async read(raw: unknown) {
      const pin = CollaborationRetainedArtifactPinSchema.parse(raw);
      if (!bridge) {
        requireStore();
        changed();
      }
      const read = await bridge.read(pin);
      read.assertCurrent();
      const { contentBase64, ...value } = read.artifact;
      const metadata = CollaborationRetainedArtifactMetadataSchema.parse(value);
      const owned = requireStore().metadataForRevision(pin.artifactId, pin.revision);
      if (
        metadata.itemId !== owned.itemId ||
        metadata.filename !== owned.filename ||
        metadata.title !== owned.title ||
        metadata.sizeBytes !== owned.size ||
        !isDeepStrictEqual(metadata.provenance, {
          sessionId: owned.sessionId,
          sourceKind: owned.sourceKind,
          sourcePath: owned.sourcePath,
        })
      )
        changed();
      assertOwned(owned, pin, true);
      const previous = reads.get(key(pin));
      if (
        previous &&
        (!isDeepStrictEqual(previous.pin, pin) || !isDeepStrictEqual(previous.metadata, owned))
      )
        changed();
      reads.set(key(pin), {
        pin,
        metadata: structuredClone(owned),
        bytes: metadata.sizeBytes,
        assertCurrent: read.assertCurrent,
      });
      if (
        reads.size > 100 ||
        [...reads.values()].reduce((sum, item) => sum + item.bytes, 0) > maximumBytes
      )
        overflow();
      return {
        ...metadata,
        bytes: Buffer.from(contentBase64, 'base64'),
        assertCurrent: read.assertCurrent,
      };
    },
    stats() {
      return {
        count: reads.size,
        bytes: [...reads.values()].reduce((sum, item) => sum + item.bytes, 0),
      };
    },
    /** Authority phase may invoke actual synchronous owner callbacks. */
    assertAuthorityCurrent() {
      for (const read of reads.values()) read.assertCurrent();
    },
    /** Finish ALL artifacts after ALL callbacks, using only actual owned reads. */
    assertOwnedCurrent() {
      for (const read of metadataReads.values()) {
        assertAssociated(read.pin);
        assertOwned(read.metadata, read.pin, false);
      }
      for (const read of reads.values()) {
        assertAssociated(read.pin);
        assertOwned(read.metadata, read.pin, true);
      }
    },
  };
}
