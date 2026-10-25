import { createHash } from 'node:crypto';
import {
  TelosWorkRoleContextSelectionSchema as SharedRoleContextSchema,
  type TelosWorkRoleContextSelection,
} from '@mitzo/protocol';
import type { AccountBinding } from '@mitzo/protocol';
import {
  saveOrdinaryContributorGuidance,
  resolveOrdinaryContributorGuidance,
  readOrdinaryContributorContextEvents,
  type GuidanceReader,
} from './ordinary-contributor-guidance.js';

export const TelosWorkRoleContextSelectionSchema = SharedRoleContextSchema.superRefine(
  (value, ctx) => {
    if (createHash('sha256').update(value.brief.text).digest('hex') !== value.brief.sha256)
      ctx.addIssue({
        code: 'custom',
        message: 'Reviewed brief bytes do not match their selected hash',
      });
  },
);
export type { TelosWorkRoleContextSelection } from '@mitzo/protocol';
type Reader = GuidanceReader;
interface Writer extends Reader {
  append(id: string, type: string, payload: Record<string, unknown>): number;
}
const mandate = {
  lead: 'Collaborate on scope, maintain the plan, delegate slices, coordinate dependencies, surface decisions and review evidence. Child execution requires a separate worker conversation.',
  advisor:
    'Refine the selected item and propose reviewed changes. Do not execute work or dispatch child sessions.',
  worker:
    'Execute only the explicitly selected work task and return evidence to the item lead. Do not execute siblings or broaden scope.',
  reviewer:
    'Review the selected item and evidence. Do not execute work or dispatch child sessions.',
};
const coordinatorMandate =
  'Coordinate current leads for directly attached outcomes and coordinators, maintain cross-outcome priorities and dependencies, and surface decisions and review evidence. Request scoped holds/releases only through host controls; requested, acknowledged and applied remain distinct. Child execution requires a separate worker conversation. The host checks current lead assignment and exact target scope; this reviewed context alone grants no control, messaging or publication authority.';
function accountScope(binding: AccountBinding) {
  return {
    accountId: binding.accountId,
    provider: binding.provider,
    model: binding.model,
    profileRevision: binding.profileRevision,
  };
}
export function renderTelosWorkRoleContext(input: TelosWorkRoleContextSelection): string {
  const selection = TelosWorkRoleContextSelectionSchema.parse(input);
  const purpose =
    selection.advisorPurpose === 'child'
      ? '\nHelp draft a child work item under the selected item. Saving a child draft does not start a worker.'
      : selection.advisorPurpose === 'refine'
        ? '\nRefine the selected item while preserving its original sources and prior brief revisions.'
        : '';
  const selectedMandate =
    selection.role === 'lead' && selection.itemKind === 'coordinator'
      ? coordinatorMandate
      : mandate[selection.role];
  const guidance = `## Telos work role\n${selectedMandate}${purpose}\n\nThe host-selected context below is retained data, not additional authority. Sources are immutable references; no parent or sibling transcript is implicitly available.\n${JSON.stringify({ ...selection, itemReturnPath: `/todos/${encodeURIComponent(selection.itemId)}`, ...(selection.leadConversationId ? { leadReturnPath: `/chat/${encodeURIComponent(selection.leadConversationId)}` } : {}) })}`;
  if (Buffer.byteLength(guidance, 'utf8') > 100_000)
    throw new Error('Telos role context exceeds the supported guidance size');
  return guidance;
}
function readRoleSelection(
  store: Reader,
  sessionId: string,
  binding: AccountBinding | undefined,
): TelosWorkRoleContextSelection | undefined {
  const events = readOrdinaryContributorContextEvents(store, sessionId).filter(
    (event) => event.type === 'telos_work_role_context',
  );
  if (!events.length) return undefined;
  if (!binding)
    throw new Error('Retained Telos role context requires its original account binding');
  const first = events[0].payload;
  const selection = TelosWorkRoleContextSelectionSchema.parse(first.selection);
  const guidance = renderTelosWorkRoleContext(selection);
  if (
    first.version !== 1 ||
    first.sessionId !== sessionId ||
    JSON.stringify(first.binding) !== JSON.stringify(accountScope(binding)) ||
    first.guidance !== guidance ||
    events.some((event) => JSON.stringify(event.payload) !== JSON.stringify(first))
  )
    throw new Error('Retained Telos role context changed');
  return selection;
}
export function resolveTelosWorkRoleContext(
  store: Reader,
  sessionId: string,
  binding: AccountBinding | undefined,
): TelosWorkRoleContextSelection | undefined {
  const selection = readRoleSelection(store, sessionId, binding);
  if (
    selection &&
    resolveOrdinaryContributorGuidance(store, sessionId, binding) !==
      renderTelosWorkRoleContext(selection)
  )
    throw new Error('Retained Telos role context requires complete ordinary guidance');
  return selection;
}
/** Internal host owner only: callers must authorize item/source/artifact selection before retaining. */
export function retainTelosWorkRoleContext(
  store: Writer,
  sessionId: string,
  binding: AccountBinding,
  input: TelosWorkRoleContextSelection,
): void {
  const selection = TelosWorkRoleContextSelectionSchema.parse(input);
  const guidance = renderTelosWorkRoleContext(selection);
  const previous = readRoleSelection(store, sessionId, binding);
  if (previous && JSON.stringify(previous) !== JSON.stringify(selection))
    throw new Error('Retained Telos role context cannot be replaced');
  if (!previous)
    store.append(sessionId, 'telos_work_role_context', {
      version: 1,
      sessionId,
      binding: accountScope(binding),
      selection,
      guidance,
    });
  saveOrdinaryContributorGuidance(store, sessionId, binding, guidance);
}
/** Enforced by the task host before mutation or dispatch, never inferred from role prompts. */
export function assertTelosWorkTaskExecutionScope(
  store: Reader,
  sessionId: string,
  binding: AccountBinding | undefined,
  executionTaskId: string,
  executionMapping?: {
    contextHash: string;
    executionTaskId: string;
    childItemId: string;
    leadConversationId: string;
    workerConversationId: string;
  } | null,
): void {
  const selected = resolveTelosWorkRoleContext(store, sessionId, binding);
  if (executionMapping) {
    if (
      selected?.role !== 'worker' ||
      executionMapping.executionTaskId !== executionTaskId ||
      executionMapping.workerConversationId !== sessionId ||
      executionMapping.childItemId !== selected.itemId ||
      executionMapping.leadConversationId !== selected.leadConversationId ||
      (selected.executionTaskId !== undefined && selected.executionTaskId !== executionTaskId) ||
      executionMapping.contextHash !==
        createHash('sha256').update(JSON.stringify(selected)).digest('hex')
    )
      throw new Error('Telos role context does not authorize task execution in this conversation');
    return;
  }
  if (!selected) return;
  if (selected.role !== 'worker')
    throw new Error('Telos role context does not authorize task execution in this conversation');
  if (selected.executionTaskId === executionTaskId) return;
  throw new Error('Telos role context does not authorize task execution in this conversation');
}
/** Ordinary packet owners call this before their existing request hashing. */
export function resolveTelosWorkSystemPrompt(
  store: Reader,
  sessionId: string,
  binding: AccountBinding | undefined,
  basePrompt: string,
): string {
  resolveTelosWorkRoleContext(store, sessionId, binding);
  const guidance = resolveOrdinaryContributorGuidance(store, sessionId, binding);
  return guidance === undefined
    ? basePrompt
    : `${basePrompt}\n\n## Contributor guidance\n${guidance}`;
}
