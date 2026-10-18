import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  TelosWorkRolePresentationSchema,
  TelosWorkRoleContextReviewSchema,
  type TelosWorkRoleContextReview,
  type AccountBinding,
  type TelosWorkRoleContextSelection,
} from '@mitzo/protocol';
import type { TelosWorkRoleReviewInput } from './telos-work-role-review.js';
import { resolveTelosWorkRoleContext } from './telos-work-role-context.js';

export const rolePresentationHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Called inside the work owner's review/admission transaction after the exact
 * selection is authorized. Every read stays within that selection's pins. */
export function captureTelosWorkRolePresentation(
  input: TelosWorkRoleReviewInput,
  selection: TelosWorkRoleContextSelection,
) {
  const readTarget =
    input.readTarget ?? ((id: string) => input.work.readSourceTarget(id, input.actor));
  const readName = (itemId: string, revision: string) => {
    const target = readTarget(itemId);
    if (target.work.revision !== revision || /^life[-_ ]?ops$/i.test(target.record.profile))
      throw new Error('Reviewed context names unavailable');
    return { itemId, revision, title: target.record.summary };
  };
  const sources = selection.sources.map((source) => {
    // Historical references without an adopted packet have no retained title.
    if (source.source?.namespace !== 'mitzo' || !source.adoptedBrief)
      return { snapshotId: source.snapshotId, title: null, createdAt: source.sourceCreatedAt };
    if (!input.readReviewedSource) throw new Error('Reviewed source labels unavailable');
    const retained = input.readReviewedSource(source.snapshotId);
    if (!isDeepStrictEqual(retained.snapshot, source))
      throw new Error('Reviewed source labels changed');
    return {
      snapshotId: source.snapshotId,
      title: retained.packet.sourceTitle,
      createdAt: retained.packet.sourceCreatedAt,
    };
  });
  const pins = [
    ...new Map(
      [...selection.artifacts, ...selection.sources.flatMap((source) => source.artifacts)].map(
        (pin) => [JSON.stringify(pin), pin],
      ),
    ).values(),
  ];
  const artifacts = pins.map((pin) => {
    if (!input.artifacts) throw new Error('Reviewed material labels unavailable');
    const artifact = input.artifacts.read(pin.artifactId, pin.revision);
    if (
      !input.artifacts.userUploadAllowed(artifact.itemId) ||
      artifact.revision !== pin.revision ||
      artifact.sha256 !== pin.sha256 ||
      createHash('sha256').update(artifact.bytes).digest('hex') !== pin.sha256
    )
      throw new Error('Reviewed material labels changed');
    return {
      ...pin,
      filename: artifact.filename,
      title: artifact.title,
      createdAt: artifact.createdAt,
      sourceKind: artifact.sourceKind,
    };
  });
  return TelosWorkRolePresentationSchema.parse({
    version: 1,
    contextSha256: rolePresentationHash(selection),
    reviewedAt: new Date().toISOString(),
    item: readName(selection.itemId, selection.brief.revision),
    overallGoal: readName(selection.overallGoal.itemId, selection.overallGoal.revision),
    parents: selection.parentCriteria.map((parent) => readName(parent.itemId, parent.revision)),
    sources,
    artifacts,
  });
}

interface PresentationReader {
  getSessionEvents(id: string): Array<{ type: string; payload: Record<string, unknown> }>;
}
interface PresentationWriter extends PresentationReader {
  append(id: string, type: string, payload: Record<string, unknown>): number;
}

const presentationAccountScope = (binding: AccountBinding) => ({
  accountId: binding.accountId,
  provider: binding.provider,
  model: binding.model,
  profileRevision: binding.profileRevision,
});
function checkedPresentation(raw: unknown): TelosWorkRoleContextReview {
  const result = TelosWorkRoleContextReviewSchema.safeParse(raw);
  if (
    !result.success ||
    result.data.presentation.contextSha256 !== rolePresentationHash(result.data.selection) ||
    result.data.presentationRef.sha256 !== rolePresentationHash(result.data.presentation)
  )
    throw new Error('Retained role presentation unavailable');
  return result.data;
}
export function resolveTelosWorkRolePresentation(
  store: PresentationReader,
  sessionId: string,
  binding: AccountBinding | undefined,
): Pick<TelosWorkRoleContextReview, 'presentation' | 'presentationRef'> | undefined {
  const events = store
    .getSessionEvents(sessionId)
    .filter((event) => event.type === 'telos_work_role_presentation');
  if (!events.length) return undefined;
  const selection = resolveTelosWorkRoleContext(store, sessionId, binding);
  if (!binding || !selection)
    throw new Error('Original bound role context required for presentation');
  const first = events[0].payload;
  const reviewed = checkedPresentation({
    version: 1,
    selection,
    presentation: first.presentation,
    presentationRef: first.presentationRef,
  });
  if (
    first.version !== 1 ||
    first.sessionId !== sessionId ||
    first.contextSha256 !== rolePresentationHash(selection) ||
    !isDeepStrictEqual(first.binding, presentationAccountScope(binding)) ||
    events.some((event) => !isDeepStrictEqual(event.payload, first))
  )
    throw new Error('Retained role presentation changed');
  return { presentation: reviewed.presentation, presentationRef: reviewed.presentationRef };
}
/** A separate event; never rewrites role selection, contributor guidance or task hashes. */
export function retainTelosWorkRolePresentation(
  store: PresentationWriter,
  sessionId: string,
  binding: AccountBinding,
  input: TelosWorkRoleContextReview,
): void {
  const reviewed = checkedPresentation(input);
  const selected = resolveTelosWorkRoleContext(store, sessionId, binding);
  if (!isDeepStrictEqual(selected, reviewed.selection))
    throw new Error('Presentation requires its exact retained role selection');
  const expected = {
    presentation: reviewed.presentation,
    presentationRef: reviewed.presentationRef,
  };
  const previous = resolveTelosWorkRolePresentation(store, sessionId, binding);
  if (previous && !isDeepStrictEqual(previous, expected))
    throw new Error('Retained role presentation cannot be replaced');
  if (!previous)
    store.append(sessionId, 'telos_work_role_presentation', {
      version: 1,
      sessionId,
      binding: presentationAccountScope(binding),
      contextSha256: rolePresentationHash(selected),
      ...expected,
    });
}
