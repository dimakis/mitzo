import { AgentProfileSelectionSchema, type AgentProfileSelection } from '@mitzo/protocol';
import { z } from 'zod';
import type { AccountSelection } from '../types/account-selection';

const reference = z.string().min(1).max(200).regex(/^\S+$/);
const accountSelection = z.strictObject({
  accountId: reference.optional(),
  model: reference,
  reasoningEffort: z.string().min(1).max(64).regex(/^\S+$/).nullable().optional(),
});

/** Editable chat intent only. Never an authorization or provider continuation. */
export const ChatRuntimeSelectionSchema = z.strictObject({
  version: z.literal(1),
  account: accountSelection.nullable(),
  agentProfile: AgentProfileSelectionSchema.nullable(),
  execution: z.strictObject({
    location: z.enum(['openshell', 'local']),
    targetId: reference.nullable(),
  }),
  capabilityRevision: reference.nullable(),
});
export type ChatRuntimeSelection = z.infer<typeof ChatRuntimeSelectionSchema>;

/** Narrow projection of validated picker metadata, independent of wire transport.
 * Available means selectable in this snapshot; the server still admits dispatch.
 */
export interface ChatRuntimeInventory {
  capabilityRevision: string;
  agentProfiles: AgentProfileSelection[];
  locations: {
    location: ChatRuntimeSelection['execution']['location'];
    available: boolean;
    reason?: string;
  }[];
  routes: {
    accountId: string;
    targetId: string;
    location: ChatRuntimeSelection['execution']['location'];
    available: boolean;
    reason?: string;
    models: { id: string; reasoningEfforts?: string[] }[];
  }[];
}

export interface ChatRuntimeSelectionIssue {
  code:
    | 'capabilities_unavailable'
    | 'capabilities_stale'
    | 'location_unavailable'
    | 'target_required'
    | 'account_required'
    | 'route_unavailable'
    | 'agent_unavailable'
    | 'model_unavailable'
    | 'thinking_required'
    | 'thinking_unavailable';
  message: string;
}

export function createChatRuntimeSelection(): ChatRuntimeSelection {
  return {
    version: 1,
    account: null,
    agentProfile: null,
    execution: { location: 'openshell', targetId: null },
    capabilityRevision: null,
  };
}

/** Keep unavailable intent visible. Inventory refresh never chooses a replacement. */
export function evaluateChatRuntimeSelection(
  selection: ChatRuntimeSelection,
  inventory: ChatRuntimeInventory | null,
) {
  const issues: ChatRuntimeSelectionIssue[] = [];
  const add = (code: ChatRuntimeSelectionIssue['code'], message: string) => {
    issues.push({ code, message });
  };
  let refreshRequired = false;
  if (!inventory) {
    add('capabilities_unavailable', 'Execution choices are unavailable. Refresh before sending.');
    refreshRequired = true;
  } else {
    if (selection.capabilityRevision !== inventory.capabilityRevision) {
      add('capabilities_stale', 'Execution choices changed. Refresh and review before sending.');
      refreshRequired = true;
    }
    const locations = inventory.locations.filter(
      (entry) => entry.location === selection.execution.location,
    );
    if (locations.length !== 1 || !locations[0].available)
      add(
        'location_unavailable',
        locations.length === 1 && locations[0].reason
          ? locations[0].reason
          : 'The selected location is unavailable. Choose an available location explicitly.',
      );
    if (!selection.execution.targetId)
      add('target_required', 'Choose an execution target before sending.');
    if (!selection.account?.accountId) add('account_required', 'Choose an account before sending.');
    if (
      selection.agentProfile &&
      !inventory.agentProfiles.some((entry) => sameProfile(entry, selection.agentProfile))
    )
      add(
        'agent_unavailable',
        'The selected agent revision is unavailable. Choose an agent explicitly.',
      );
    if (selection.account?.accountId && selection.execution.targetId) {
      const routes = inventory.routes.filter(
        (entry) =>
          entry.accountId === selection.account!.accountId &&
          entry.targetId === selection.execution.targetId &&
          entry.location === selection.execution.location,
      );
      if (routes.length !== 1 || !routes[0].available)
        add(
          'route_unavailable',
          routes.length === 1 && routes[0].reason
            ? routes[0].reason
            : 'The selected account and target are unavailable together. Review the choices.',
        );
      if (routes.length === 1) {
        const models = routes[0].models.filter((entry) => entry.id === selection.account!.model);
        if (models.length !== 1)
          add('model_unavailable', 'The selected model is unavailable. Choose a model explicitly.');
        else if (models[0].reasoningEfforts?.length && selection.account.reasoningEffort == null)
          add('thinking_required', 'Choose a supported thinking level before sending.');
        else if (
          selection.account.reasoningEffort != null &&
          !models[0].reasoningEfforts?.includes(selection.account.reasoningEffort)
        )
          add(
            'thinking_unavailable',
            'The selected thinking level is unavailable. Choose a level explicitly.',
          );
      }
    }
  }
  return { selection, ready: issues.length === 0, issues, refreshRequired };
}

function sameProfile(left: AgentProfileSelection | null, right: AgentProfileSelection | null) {
  return left?.profileId === right?.profileId && left?.revision === right?.revision;
}

/** Model/thinking are future-command intent; account/profile/location remain bound. */
export function replaceChatRuntimeSelection(
  current: ChatRuntimeSelection,
  candidate: ChatRuntimeSelection,
  bound?: ChatRuntimeSelection,
) {
  if (
    bound &&
    (bound.account?.accountId !== candidate.account?.accountId ||
      !sameProfile(bound.agentProfile, candidate.agentProfile) ||
      bound.execution.location !== candidate.execution.location ||
      bound.execution.targetId !== candidate.execution.targetId)
  )
    return {
      accepted: false,
      selection: current,
      reason: 'Start a new conversation to change its account, agent or execution target.',
    };
  return { accepted: true, selection: candidate };
}

/** Retain this copy for an exact retry; editing the draft must not rebuild it. */
export function snapshotChatRuntimeSelection(
  selection: ChatRuntimeSelection,
  inventory: ChatRuntimeInventory | null,
): ChatRuntimeSelection | null {
  return evaluateChatRuntimeSelection(selection, inventory).ready
    ? structuredClone(selection)
    : null;
}

/** Older draft settings writers may omit runtime intent. Retain its target, but
 * invalidate reviewed capabilities when their account/model/thinking tuple changes.
 */
export function retainChatRuntimeSelection(
  runtime: ChatRuntimeSelection | null | undefined,
  account: AccountSelection | null,
  agentProfile?: AgentProfileSelection | null,
): ChatRuntimeSelection | null | undefined {
  if (!runtime) return runtime;
  const profile = agentProfile === undefined ? runtime.agentProfile : agentProfile;
  if (
    runtime.account?.accountId === account?.accountId &&
    runtime.account?.model === account?.model &&
    runtime.account?.reasoningEffort === account?.reasoningEffort &&
    sameProfile(runtime.agentProfile, profile)
  )
    return runtime;
  return {
    ...runtime,
    account: account ? { ...account } : null,
    agentProfile: profile,
    capabilityRevision: null,
  };
}

/** Existing profile picker URL edits are explicit intent, including Default Mitzo. */
export function chatAgentProfileFromSearch(search: string): AgentProfileSelection | null {
  const params = new URLSearchParams(search);
  const parsed = AgentProfileSelectionSchema.safeParse({
    profileId: params.get('agentProfile'),
    revision: Number(params.get('profileRevision')),
  });
  return parsed.success ? parsed.data : null;
}
