import { isDeepStrictEqual } from 'node:util';
import type { SessionRuntimeBindingV2, AgentProfileSelection } from '@mitzo/protocol';
type Account = SessionRuntimeBindingV2['account'];
type Model = {
  id: string;
  label: string;
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
};
type Discovery = { source: 'cached' | 'configured'; stale: boolean; updatedAt?: number };
type Entry = { account: Account; label: string; models: Model[]; modelDiscovery: Discovery };
interface Source {
  capabilityRevision: string;
  accounts: Entry[];
  routes: {
    account: Account;
    targetId: string;
    location?: 'local' | 'openshell';
    harness: 'codex' | 'responses' | 'claude-sdk';
    modes: readonly ('ask' | 'agent' | 'auto')[];
    skillCeiling?: 'unsupported';
    agentProfiles?: AgentProfileSelection[];
    agentProfileRejections?: {
      agent: AgentProfileSelection;
      reason:
        | 'provider_incompatible'
        | 'sandbox_context_preset_unconfigured'
        | 'native_pack_context_unavailable'
        | 'native_context_unavailable';
    }[];
  }[];
}
/** Pure projection of already-resolved owning catalogs, never an authority registry.
 * Account identity stays singular; target-specific choices retain their own snapshots.
 */
export function composeOrdinaryRuntimeCapabilities(sources: readonly (Source | undefined)[]) {
  const accounts = new Map<string, Entry>();
  const routes: Array<
    Source['routes'][number] & {
      capabilityRevision: string;
      models: Model[];
      modelDiscovery: Discovery;
    }
  > = [];
  for (const source of sources) {
    if (!source) continue;
    for (const entry of source.accounts) {
      const old = accounts.get(entry.account.accountId);
      if (!old) {
        accounts.set(entry.account.accountId, structuredClone(entry));
        continue;
      }
      if (!isDeepStrictEqual(old.account, entry.account) || old.label !== entry.label)
        throw Error('Runtime account identity changed');
      for (const model of entry.models) {
        const retained = old.models.find((candidate) => candidate.id === model.id);
        if (!retained) old.models.push(structuredClone(model));
        else if (!isDeepStrictEqual(retained, model)) {
          retained.reasoningEfforts = [
            ...new Set([...(retained.reasoningEfforts ?? []), ...(model.reasoningEfforts ?? [])]),
          ];
          if (retained.defaultReasoningEffort !== model.defaultReasoningEffort)
            delete retained.defaultReasoningEffort;
        }
      }
      old.modelDiscovery.stale &&= entry.modelDiscovery.stale;
    }
    for (const route of source.routes) {
      const entry = source.accounts.find((candidate) =>
        isDeepStrictEqual(candidate.account, route.account),
      );
      if (!entry) throw Error('Runtime route has no owning account');
      routes.push({
        ...structuredClone(route),
        capabilityRevision: source.capabilityRevision,
        models: structuredClone(entry.models),
        modelDiscovery: structuredClone(entry.modelDiscovery),
      });
    }
  }
  return { accounts: [...accounts.values()], routes };
}
