import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  CollaborationContractError,
  CollaborationSettingsSchema,
  CollaborationReviewIdentitySchema,
  collaborationCapacityOperationKey,
  CollaborationNativeCapacityAssessmentSchema,
  CollaborationNativeCapacityWitnessSchema,
  type CollaborationNativeCapacityWitness,
  CollaborationSnapshotDraftSchema,
  CollaborationSnapshotMessageSchema,
  CollaborationSnapshotSelectionSchema,
  type CollaborationSettings,
  type CollaborationSnapshotSelection,
} from '@mitzo/protocol';

type Draft = z.infer<typeof CollaborationSnapshotDraftSchema>;
type Message = Draft['messages'][number];
type ArtifactPin = CollaborationSnapshotSelection['artifacts'][number];
type Context = Omit<Draft, 'requestId' | 'capacity' | 'summary'>;
const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const PAGE_SIZE = 50;
const MAX_PAGES = 1000;
const MAX_BYTES = 512 * 1024;
const sequence = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
const pageSchema = z.strictObject({
  sourceIdentity: z.string().min(1).max(200),
  afterSequence: sequence,
  throughSequence: sequence,
  hasMore: z.boolean(),
  messages: z.array(CollaborationSnapshotMessageSchema).max(PAGE_SIZE),
  artifacts: CollaborationSnapshotSelectionSchema.shape.artifacts,
});
type Page = z.infer<typeof pageSchema>;

/** Host-owned source capability. Never construct this object from HTTP input.
 * Opening authorizes the visible application prefix and verifies the exact boundary.
 * Each page scans (afterSequence, throughSequence], including non-message gaps, and
 * enumerates every visible message and exact artifact reference in that interval.
 * sourceIdentity binds that immutable prefix across pages; assertCurrent rechecks
 * its integrity and operator/source authority. Private provider history is excluded.
 */
export interface AuthorizedCollaborationContext {
  openConversation(selection: CollaborationSnapshotSelection): Promise<{
    sourceIdentity: string;
    sourceConversationId: string;
    boundary: CollaborationSnapshotSelection['boundary'];
    /** Independent complete-prefix witness, requested only for Conversation so far. */
    readPrefixWitness(): Promise<{
      messageCount: number;
      messagesSha256: string;
      artifactPins: ArtifactPin[];
    }>;
    readPage(afterSequence: number, limit: number): Promise<Page>;
    readSelected(messageIds: string[]): Promise<Message[]>;
    assertCurrent(): Promise<void>;
  }>;
  authorizeArtifact(pin: ArtifactPin): Promise<void>;
  readArtifact(pin: ArtifactPin): Promise<
    ArtifactPin & {
      sourceConversationId: string;
      mediaType: string;
      bytes: Uint8Array;
    }
  >;
}

/** A registered ordinary adapter must measure its actual serialized joining packet,
 * standard boot/guidance/repository instructions, tool definitions and framing for
 * this exact selection. Native preparation/counting must be non-generating and
 * retain its private witness; no allocation or dispatch is permitted here.
 * Legacy additive results remain historical/test evidence, never native authority.
 * A missing adapter is unverified; character heuristics are not a ready assessment.
 */
export interface CollaborationCapacityAdapter {
  measure(input: {
    settings: CollaborationSettings;
    context: Context;
    contextSha256: string;
    /** Original durable review+settings identity, never derived from mutable source bytes. */
    nativeOperationId?: string;
  }): Promise<
    | UnavailableCollaborationCapacityMeasurement
    | NativeCollaborationCapacityMeasurement
    | {
        settings: CollaborationSettings;
        contextSha256: string;
        contextTokens: number;
        adapterTokens: number;
        bootTokens: number;
        toolTokens: number;
        reservedOutputTokens: number;
        contextWindowTokens: number;
        estimatorRevision: string;
      }
  >;
}

export interface UnavailableCollaborationCapacityMeasurement {
  kind: 'unavailable';
  settings: CollaborationSettings;
  contextSha256: string;
  status: 'unverified' | 'refused';
  /** Fixed public-safe explanation; never forward native/provider error text. */
  reason: string;
}
export interface NativeCollaborationCapacityMeasurement {
  kind: 'nativePreparedRequest';
  scope: 'reviewContext';
  settings: CollaborationSettings;
  contextSha256: string;
  inputTokens: number;
  maxOutputTokens: number;
  contextWindowTokens: number;
  nativeWitness: CollaborationNativeCapacityWitness['nativeWitness'];
}

function changed(): never {
  throw new CollaborationContractError('snapshot_changed');
}
function bounded(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_BYTES)
    throw new CollaborationContractError('capacity_refused');
}
function unique(values: string[]) {
  if (new Set(values).size !== values.length) changed();
}
const artifactKey = (pin: ArtifactPin) => `${pin.artifactId}:${pin.revision}`;

export interface CollaborationCompilationOptions {
  reviewIdentity?: z.infer<typeof CollaborationReviewIdentitySchema>;
  retainNativeWitnesses?: (witnesses: CollaborationNativeCapacityWitness[]) => void;
}
/** Compile only. The EventStore remains the review/persistence owner. Callers must
 * recover an existing operation receipt before recompiling on a mutation retry.
 * No public execution route or account/runtime is qualified by this host-only port.
 */
export async function compileCollaborationContext(
  rawSelection: unknown,
  rawSettings: unknown,
  sources: AuthorizedCollaborationContext,
  adapter?: CollaborationCapacityAdapter,
  options: CollaborationCompilationOptions = {},
): Promise<Draft> {
  const input = CollaborationSnapshotSelectionSchema.parse(rawSelection);
  const parsedSettings = z.array(CollaborationSettingsSchema).min(1).max(16).parse(rawSettings);
  return compileSource(input, parsedSettings, sources, adapter, options);
}

/** Retain an explicitly selected source before any recipient/lead exists. Shares
 * the exact compiler, source checks and byte bounds; capacity stays unverified.
 * This port cannot measure, allocate, prepare or admit an ordinary conversation.
 */
export async function compileCollaborationSourceContext(
  rawSelection: unknown,
  sources: AuthorizedCollaborationContext,
): Promise<Draft> {
  return compileSource(CollaborationSnapshotSelectionSchema.parse(rawSelection), [], sources);
}

async function compileSource(
  input: CollaborationSnapshotSelection,
  parsedSettings: CollaborationSettings[],
  sources: AuthorizedCollaborationContext,
  adapter?: CollaborationCapacityAdapter,
  options: CollaborationCompilationOptions = {},
): Promise<Draft> {
  const reviewIdentity =
    options.reviewIdentity && CollaborationReviewIdentitySchema.parse(options.reviewIdentity);
  if (reviewIdentity && reviewIdentity.requestId !== input.requestId) changed();
  const nativeWitnesses: CollaborationNativeCapacityWitness[] = [];
  // Assess identical selections once. Settings equality never combines session ownership.
  const settings = [
    ...new Map(parsedSettings.map((selected) => [JSON.stringify(selected), selected])).values(),
  ];
  unique(input.messageIds);
  unique(input.artifacts.map(artifactKey));
  if (input.mode === 'conversation_so_far' && input.messageIds.length) changed();
  const opened = await sources.openConversation(structuredClone(input));
  if (
    !opened.sourceIdentity ||
    opened.sourceConversationId !== input.sourceConversationId ||
    !isDeepStrictEqual(opened.boundary, input.boundary)
  )
    changed();
  const context: Context = {
    sourceConversationId: input.sourceConversationId,
    boundary: structuredClone(input.boundary),
    mode: input.mode,
    purpose: input.purpose,
    joiningBrief: input.joiningBrief,
    messages: [],
    artifacts: [],
  };
  const pins = new Map(input.artifacts.map((pin) => [artifactKey(pin), pin]));
  const addPin = (pin: ArtifactPin) => {
    const key = artifactKey(pin);
    const previous = pins.get(key);
    if (previous && !isDeepStrictEqual(previous, pin)) changed();
    pins.set(key, pin);
    if (pins.size > 100) throw new CollaborationContractError('capacity_refused');
  };
  const seen = new Set<string>();
  function addMessage(raw: Message, after: number, through: number) {
    const message = CollaborationSnapshotMessageSchema.parse(raw);
    if (
      message.conversationId !== input.sourceConversationId ||
      seen.has(message.messageId) ||
      message.sequence <= after ||
      message.sequence > through ||
      message.sequence <= (context.messages.at(-1)?.sequence ?? -1) ||
      (message.source &&
        message.author !== 'operator' &&
        message.source.conversationId !== message.author.sessionId)
    )
      changed();
    unique(message.blocks.map((block) => block.blockId));
    for (const block of message.blocks) if (sha(block.content) !== block.sha256) changed();
    if (message.source && message.blocks.some((b) => !message.source!.blockIds.includes(b.blockId)))
      changed();
    seen.add(message.messageId);
    context.messages.push(message);
    if (context.messages.length > 500) throw new CollaborationContractError('capacity_refused');
    bounded(context);
  }
  if (input.mode === 'conversation_so_far') {
    const witness = z
      .strictObject({
        messageCount: sequence,
        messagesSha256: z.string().regex(/^[a-f0-9]{64}$/),
        artifactPins: CollaborationSnapshotSelectionSchema.shape.artifacts,
      })
      .parse(await opened.readPrefixWitness());
    unique(witness.artifactPins.map(artifactKey));
    if (witness.messageCount > 500) throw new CollaborationContractError('capacity_refused');
    const referenced = new Map<string, ArtifactPin>();
    let after = 0;
    for (let count = 0; ; count++) {
      if (count === MAX_PAGES) throw new CollaborationContractError('capacity_refused');
      const page = pageSchema.parse(await opened.readPage(after, PAGE_SIZE));
      if (
        page.sourceIdentity !== opened.sourceIdentity ||
        page.afterSequence !== after ||
        page.throughSequence < after ||
        page.throughSequence > input.boundary.sequence ||
        (page.throughSequence === after && input.boundary.sequence !== 0) ||
        page.hasMore !== page.throughSequence < input.boundary.sequence
      )
        changed();
      for (const message of page.messages) addMessage(message, after, page.throughSequence);
      page.artifacts.forEach((pin) => {
        addPin(pin);
        referenced.set(artifactKey(pin), pin);
      });
      if (!page.hasMore) break;
      after = page.throughSequence;
    }
    if ((context.messages.at(-1)?.messageId ?? null) !== input.boundary.messageId) changed();
    if (
      context.messages.length !== witness.messageCount ||
      sha(JSON.stringify(context.messages)) !== witness.messagesSha256 ||
      !isDeepStrictEqual(
        [...referenced.values()].sort((a, b) => artifactKey(a).localeCompare(artifactKey(b))),
        [...witness.artifactPins].sort((a, b) => artifactKey(a).localeCompare(artifactKey(b))),
      )
    )
      changed();
  } else if (input.messageIds.length) {
    const selected = z
      .array(CollaborationSnapshotMessageSchema)
      .max(500)
      .parse(await opened.readSelected([...input.messageIds]));
    if (
      selected.length !== input.messageIds.length ||
      selected.some((message) => !input.messageIds.includes(message.messageId))
    )
      changed();
    for (const message of selected.sort((a, b) => a.sequence - b.sequence))
      addMessage(message, 0, input.boundary.sequence);
  }
  for (const pin of pins.values()) {
    await sources.authorizeArtifact(structuredClone(pin));
    const artifact = await sources.readArtifact(structuredClone(pin));
    if (artifact.bytes.byteLength > MAX_BYTES)
      throw new CollaborationContractError('capacity_refused');
    if (
      artifact.artifactId !== pin.artifactId ||
      artifact.revision !== pin.revision ||
      artifact.sha256 !== pin.sha256 ||
      sha(artifact.bytes) !== pin.sha256
    )
      changed();
    context.artifacts.push({
      ...pin,
      sourceConversationId: artifact.sourceConversationId,
      mediaType: artifact.mediaType,
      sizeBytes: artifact.bytes.byteLength,
      contentBase64: Buffer.from(artifact.bytes).toString('base64'),
    });
    bounded(context);
  }
  const draft: Draft = {
    requestId: input.requestId,
    ...context,
    capacity: { status: 'unverified', reason: 'No exact ordinary capacity adapter is registered.' },
    summary: null,
  };
  // Validate source metadata and complete byte bounds before an adapter can inspect it.
  CollaborationSnapshotDraftSchema.parse(draft);
  bounded(draft);
  if (adapter) {
    const assessments: Extract<Draft['capacity'], { status: 'ready' }>['assessments'] = [];
    let exceeds = false;
    let unavailable: { status: 'unverified' | 'refused'; reason: string } | undefined;
    for (const selected of settings) {
      const contextSha256 = sha(JSON.stringify(context));
      const nativeOperationId = reviewIdentity
        ? `collaboration-review:${sha(collaborationCapacityOperationKey(reviewIdentity, selected))}`
        : undefined;
      const rawMeasurement = await adapter.measure({
        nativeOperationId,
        settings: structuredClone(selected),
        context: structuredClone(context),
        contextSha256,
      });
      bounded(rawMeasurement);
      if ('kind' in rawMeasurement && rawMeasurement.kind === 'unavailable') {
        const result = z
          .strictObject({
            kind: z.literal('unavailable'),
            settings: CollaborationSettingsSchema,
            contextSha256: z.literal(contextSha256),
            status: z.enum(['unverified', 'refused']),
            reason: z.string().trim().min(1).max(1000),
          })
          .parse(rawMeasurement);
        if (!isDeepStrictEqual(result.settings, selected)) changed();
        if (!unavailable || result.status === 'refused')
          unavailable = { status: result.status, reason: result.reason };
        continue;
      }
      if ('kind' in rawMeasurement && rawMeasurement.kind === 'nativePreparedRequest') {
        const measurement = z
          .strictObject({
            kind: z.literal('nativePreparedRequest'),
            scope: z.literal('reviewContext'),
            settings: CollaborationSettingsSchema,
            contextSha256: z.literal(contextSha256),
            inputTokens: z.number().int().nonnegative().safe(),
            maxOutputTokens: z.number().int().positive().safe(),
            contextWindowTokens: z.number().int().positive().safe(),
            nativeWitness: CollaborationNativeCapacityWitnessSchema.shape.nativeWitness,
          })
          .parse(rawMeasurement);
        if (!isDeepStrictEqual(measurement.settings, selected)) changed();
        if (!nativeOperationId) {
          unavailable ??= {
            status: 'unverified',
            reason: 'Native capacity requires the original retained ordinary review operation.',
          };
          continue;
        }
        const total = measurement.inputTokens + measurement.maxOutputTokens;
        if (!Number.isSafeInteger(total)) throw new CollaborationContractError('capacity_refused');
        if (total > measurement.contextWindowTokens) exceeds = true;
        else {
          const assessment = CollaborationNativeCapacityAssessmentSchema.parse({
            kind: measurement.kind,
            scope: measurement.scope,
            settings: measurement.settings,
            measurementId: randomUUID(),
            inputTokens: measurement.inputTokens,
            maxOutputTokens: measurement.maxOutputTokens,
            contextWindowTokens: measurement.contextWindowTokens,
          });
          assessments.push(assessment);
          nativeWitnesses.push({
            assessment,
            nativeOperationId,
            contextSha256,
            nativeWitness: measurement.nativeWitness,
          });
        }
        continue;
      }
      const measurement = z
        .strictObject({
          settings: CollaborationSettingsSchema,
          contextSha256: z.literal(contextSha256),
          contextTokens: sequence,
          adapterTokens: sequence,
          bootTokens: sequence,
          toolTokens: sequence,
          reservedOutputTokens: sequence,
          contextWindowTokens: sequence,
          estimatorRevision: z.string().min(1).max(200).regex(/^\S+$/),
        })
        .parse(rawMeasurement);
      if (!isDeepStrictEqual(measurement.settings, selected)) changed();
      const { settings: measuredSettings, estimatorRevision } = measurement;
      const components = {
        contextTokens: measurement.contextTokens,
        adapterTokens: measurement.adapterTokens,
        bootTokens: measurement.bootTokens,
        toolTokens: measurement.toolTokens,
        reservedOutputTokens: measurement.reservedOutputTokens,
        contextWindowTokens: measurement.contextWindowTokens,
      };
      const estimatedTokens =
        components.contextTokens +
        components.adapterTokens +
        components.bootTokens +
        components.toolTokens;
      const availableTokens = components.contextWindowTokens - components.reservedOutputTokens;
      if (
        !Number.isSafeInteger(estimatedTokens) ||
        !Number.isSafeInteger(availableTokens) ||
        estimatedTokens >= Number.MAX_SAFE_INTEGER
      )
        throw new CollaborationContractError('capacity_refused');
      if (estimatedTokens > availableTokens) exceeds = true;
      else
        assessments.push({
          settings: measuredSettings,
          estimatedTokens,
          availableTokens,
          estimatorRevision,
          components,
        });
    }
    draft.capacity =
      unavailable ??
      (exceeds
        ? {
            status: 'needs_reviewed_summary',
            reason:
              'The complete packet and ordinary overhead exceed the selected context capacity. Narrow the selection or review a separate attributed summary.',
          }
        : { status: 'ready', assessments });
  }
  await opened.assertCurrent();
  for (const pin of pins.values()) await sources.authorizeArtifact(structuredClone(pin));
  bounded(draft);
  const result = CollaborationSnapshotDraftSchema.parse(draft);
  // Only publish the private association to the review owner after every source
  // fence and final byte/schema check succeeds. Refused reviews retain no witness.
  if (result.capacity.status === 'ready' && nativeWitnesses.length) {
    bounded(nativeWitnesses);
    options.retainNativeWitnesses?.(structuredClone(nativeWitnesses));
  }
  return result;
}
