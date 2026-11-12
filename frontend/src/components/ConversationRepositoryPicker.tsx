import { useEffect, useState } from 'react';
import type { ConversationAgentSetup } from '../lib/conversation-joining-review';
import {
  ExplicitLocalInventorySchema,
  normalizeLocalInventory,
  type ExplicitLocalInventory,
} from '../lib/explicit-local-chat';
import { apiFetch } from '../lib/api-fetch';
import { RepositoryChatPicker } from './RepositoryChatPicker';

/** Existing ordinary preview/preparation controls, scoped to this fresh participant. */
export function ConversationRepositoryPicker({
  setup,
  onChange,
}: {
  setup: ConversationAgentSetup;
  onChange(values: Partial<ConversationAgentSetup>): void;
}) {
  const [inventory, setInventory] = useState<ExplicitLocalInventory>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(undefined);
    void apiFetch('/api/chat/runtime/capabilities?workspaceDefaults=1', {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw Error('Execution choices are unavailable.');
        return ExplicitLocalInventorySchema.parse(await response.json());
      })
      .then((value) => {
        if (!controller.signal.aborted) setInventory(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Execution choices unavailable.');
      });
    return () => controller.abort();
  }, [attempt]);
  const routes = inventory
    ? inventory.routes
        .flatMap((configured) => {
          if (
            configured.harness !== 'codex' &&
            !(configured.harness === 'claude-sdk' && setup.runOn === 'local')
          )
            return [];
          return normalizeLocalInventory({ ...inventory, routes: [configured] }).routes.map(
            (route) => ({ ...route, harness: configured.harness }),
          );
        })
        .filter(
          (r) =>
            r.available &&
            r.accountId === setup.selection?.accountId &&
            r.location === setup.runOn &&
            r.models.some((m) => m.id === setup.selection?.model) &&
            inventory.targets.some(
              (t) =>
                t.targetId === r.targetId && t.location === setup.runOn && t.harness === r.harness,
            ),
        )
    : [];
  const route = routes.length === 1 ? routes[0] : undefined;
  return (
    <>
      {error && (
        <>
          <p role="alert">{error}</p>
          <button type="button" className="home-secondary" onClick={() => setAttempt((n) => n + 1)}>
            Refresh execution choices
          </button>
        </>
      )}
      {route?.accountReference && setup.selection?.accountId ? (
        <RepositoryChatPicker
          key={setup.selection.accountId + ':' + setup.runOn}
          accountId={setup.selection.accountId}
          model={setup.selection.model}
          required
          draftScoped
          initialPreparationId={setup.repositoryWorkspaceId}
          ordinaryRuntime={{
            runOn: setup.runOn,
            runtime: {
              account: route.accountReference,
              harness: route.harness,
              targetId: route.targetId,
            },
          }}
          onChange={(value) =>
            onChange({
              repositoryWorkspaceId: value?.repositoryWorkspaceId,
              permissionMode: 'agent',
            })
          }
        />
      ) : (
        <p role="status">
          {inventory
            ? 'Choose an account, model and supported environment to prepare a fresh repository.'
            : 'Loading execution choices…'}
        </p>
      )}
    </>
  );
}
