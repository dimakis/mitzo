import { useRef, useEffect } from 'react';
import { ChatRuntimeDraftContext } from '../hooks/chat-runtime-draft-context';
import type { ExplicitLocalInventory } from '../lib/explicit-local-chat';
import type { AgentTaskDefinition } from '@mitzo/protocol';
import { useExplicitLocalChat } from '../hooks/useExplicitLocalChat';
import { runtimeModelAccounts, selectedRuntimeRoute } from '../lib/chat-runtime-route';
import type { ChatRuntimeSelection } from '../lib/chat-runtime-selection';
import { AgentSettingsPicker } from './AgentSettingsPicker';
import { AccountModelPicker } from './AccountModelPicker';
import { ChatExecutionPicker } from './ChatExecutionPicker';

export function AgentTaskSettings(props: {
  id: string;
  value: ChatRuntimeSelection;
  onChange(value: ChatRuntimeSelection, execution?: AgentTaskDefinition['execution']): void;
  profileLabel: string;
  disabled?: boolean;
  resolveSavedTarget?: boolean;
  retainedExecution?: AgentTaskDefinition['execution'];
}) {
  const inventory = useRef<ExplicitLocalInventory | null>(null);
  const update = (intent: ChatRuntimeSelection, origin?: 'hydrate') => {
    if (origin === 'hydrate') {
      props.onChange(intent);
      return;
    }
    const route = selectedRuntimeRoute(intent, inventory.current);
    const retained = props.retainedExecution;
    const sameRetainedRoute =
      retained &&
      intent.execution.targetId === retained.targetId &&
      JSON.stringify(intent.accountReference) === JSON.stringify(retained.account);
    const harness = route?.harness ?? (sameRetainedRoute ? retained.harness : undefined);
    const execution =
      harness && intent.account?.model && intent.accountReference && intent.execution.targetId
        ? {
            account: intent.accountReference,
            harness,
            targetId: intent.execution.targetId,
            model: intent.account.model,
            reasoningEffort: intent.account.reasoningEffort ?? null,
            mode: retained?.mode ?? ('agent' as const),
            authorityRefs: sameRetainedRoute ? retained.authorityRefs : [],
          }
        : null;
    props.onChange(intent, execution);
  };
  return (
    <ChatRuntimeDraftContext.Provider value={{ selection: props.value, update }}>
      <TaskSettingsFields {...props} inventoryRef={inventory} />
    </ChatRuntimeDraftContext.Provider>
  );
}
function TaskSettingsFields({
  id,
  value,
  profileLabel,
  disabled,
  resolveSavedTarget,
  onChange,
  inventoryRef,
}: Parameters<typeof AgentTaskSettings>[0] & {
  inventoryRef: { current: ExplicitLocalInventory | null };
}) {
  const runtime = useExplicitLocalChat(`agent-task:${id}`, value, null, true);
  const intent = runtime.intent;
  inventoryRef.current = runtime.inventory;
  useEffect(() => {
    if (
      !resolveSavedTarget ||
      !value.execution.targetId ||
      value.capabilityRevision ||
      !runtime.inventory
    )
      return;
    const targets = runtime.inventory.targets.filter(
      (t) => t.targetId === value.execution.targetId,
    );
    if (targets.length === 1 && targets[0].location !== value.execution.location)
      onChange({ ...value, execution: { ...value.execution, location: targets[0].location } });
  }, [resolveSavedTarget, value, runtime.inventory, onChange]);
  const accounts = runtimeModelAccounts(intent, runtime.inventory);
  return (
    <AgentSettingsPicker
      summary={{
        agent: profileLabel,
        account:
          accounts.find((a) => a.id === intent.account?.accountId)?.label ??
          intent.account?.accountId,
        model: intent.account?.model,
        thinking: intent.account?.reasoningEffort ?? undefined,
        location: intent.execution.location,
      }}
      agent={
        <p>
          Agent: {profileLabel} · r{intent.agentProfile?.revision}
        </p>
      }
      accountModel={
        <AccountModelPicker
          presentation="settings"
          sessionId={null}
          preferredModel=""
          onChange={() => {}}
          controlled={{
            accounts,
            selection: intent.account,
            accountNeedsConfirmation: runtime.accountNeedsConfirmation,
            onAccountChange: (account) =>
              runtime.update({ ...intent, account, capabilityRevision: null }, true),
            onChange: (account) => runtime.update({ ...intent, account, capabilityRevision: null }),
          }}
          disabled={disabled}
        />
      }
      execution={
        <ChatExecutionPicker
          runtime={{ ...runtime, visible: true }}
          presentation="settings"
          disabled={disabled}
        />
      }
      details={
        <p>
          Task settings are independent of the profile, builder and session. Saving intent does not
          start work.
        </p>
      }
      disabled={disabled}
      onDone={runtime.review}
    />
  );
}
