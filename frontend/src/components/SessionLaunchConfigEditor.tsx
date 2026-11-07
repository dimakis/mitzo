import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { SessionLaunchConfig } from '@mitzo/protocol';
import { ChatRuntimeDraftContext } from '../hooks/chat-runtime-draft-context';
import { useExplicitLocalChat } from '../hooks/useExplicitLocalChat';
import { runtimeModelAccounts } from '../lib/chat-runtime-route';
import type { ChatRuntimeSelection } from '../lib/chat-runtime-selection';
import { sessionLaunchRuntime } from '../lib/session-launch-defaults';
import { AccountModelPicker } from './AccountModelPicker';
import { ChatAgentProfilePicker } from './ChatAgentProfilePicker';
import { ChatExecutionPicker } from './ChatExecutionPicker';

/** The ordinary pickers edit isolated launch intent; they cannot retarget the source chat. */
export function SessionLaunchConfigEditor(props: {
  configuration: SessionLaunchConfig;
  onChange(configuration: SessionLaunchConfig): void;
  disabled?: boolean;
  onValidityChange?(reason: string | null): void;
}) {
  const { configuration, onChange } = props;
  const currentConfiguration = useRef(configuration);
  currentConfiguration.current = configuration;
  const [capabilityRevision, setCapabilityRevision] = useState<string | null>(null);
  const selection = useMemo(
    () => ({ ...configuration.runtime, capabilityRevision }),
    [configuration.runtime, capabilityRevision],
  );
  const context = useMemo(
    () => ({
      selection,
      update(next: ChatRuntimeSelection) {
        // Inventory observation/review may finish after an explicit field edit.
        // A callback from an older configuration cannot restore that snapshot.
        if (currentConfiguration.current !== configuration) return;
        const updated = { ...configuration, runtime: sessionLaunchRuntime(next) };
        currentConfiguration.current = updated;
        setCapabilityRevision(next.capabilityRevision);
        onChange(updated);
      },
    }),
    [selection, configuration, onChange],
  );
  return (
    <ChatRuntimeDraftContext.Provider value={context}>
      <LaunchFields {...props} />
    </ChatRuntimeDraftContext.Provider>
  );
}

function LaunchFields({
  configuration,
  onChange,
  disabled = false,
  onValidityChange,
}: Parameters<typeof SessionLaunchConfigEditor>[0]) {
  const id = useId();
  const runtime = useExplicitLocalChat(
    `session-launch-${id}`,
    { ...configuration.runtime, capabilityRevision: null },
    null,
    true,
  );
  const reviewRuntime = runtime.review;
  useEffect(() => {
    if (runtime.inventory && runtime.intent.capabilityRevision === null) reviewRuntime();
  }, [runtime.inventory, runtime.intent.capabilityRevision, reviewRuntime]);
  useEffect(() => {
    onValidityChange?.(runtime.reason ?? null);
  }, [runtime.reason, onValidityChange]);
  return (
    <div className="session-launch-configuration">
      <AccountModelPicker
        sessionId={null}
        preferredModel={configuration.runtime.account?.model ?? ''}
        onChange={() => {}}
        presentation="settings"
        disabled={disabled}
        defaultsControl={false}
        controlled={{
          accounts: runtimeModelAccounts(runtime.intent, runtime.inventory),
          selection: runtime.intent.account,
          accountNeedsConfirmation: runtime.accountNeedsConfirmation,
          accountReference: runtime.intent.accountReference,
          onAccountChange: (account) =>
            runtime.update({ ...runtime.intent, account, capabilityRevision: null }, true),
          onChange: (account) =>
            runtime.update({ ...runtime.intent, account, capabilityRevision: null }),
          onRefresh: runtime.refresh,
        }}
      />
      <ChatAgentProfilePicker
        sessionId={null}
        search=""
        updateSearchParams={false}
        onChange={() => {}}
        disabled={disabled}
        label="Agent"
        controlled={{
          versions: runtime.inventory?.agentProfiles ?? [],
          selection: runtime.intent.agentProfile,
          onChange: (agentProfile) =>
            runtime.update({ ...runtime.intent, agentProfile, capabilityRevision: null }),
        }}
      />
      <ChatExecutionPicker runtime={runtime} disabled={disabled} presentation="settings" />
      <label>
        Permission mode
        <select
          disabled={disabled}
          value={configuration.mode}
          onChange={(event) =>
            onChange({ ...configuration, mode: event.target.value as SessionLaunchConfig['mode'] })
          }
        >
          <option value="ask">Ask</option>
          <option value="agent">Agent</option>
          <option value="auto">Auto</option>
        </select>
      </label>
      <label className="session-launch-check">
        <input
          type="checkbox"
          disabled={disabled}
          checked={configuration.isolation}
          onChange={(event) => onChange({ ...configuration, isolation: event.target.checked })}
        />
        Isolated checkout
      </label>
      <label>
        Context
        <textarea
          disabled={disabled}
          value={configuration.contextBlocks.join('\n\n')}
          onChange={(event) =>
            onChange({
              ...configuration,
              contextBlocks: event.target.value ? [event.target.value] : [],
            })
          }
        />
      </label>
      <label>
        Additional tools
        <input
          disabled={disabled}
          value={configuration.extraTools.join(', ')}
          onChange={(event) =>
            onChange({
              ...configuration,
              extraTools: event.target.value
                .split(',')
                .map((tool) => tool.trim())
                .filter(Boolean),
            })
          }
        />
      </label>
      {configuration.repositoryWorkspaceId && (
        <>
          <p role="status">
            The saved repository requires a fresh checkout review before this session can start.
          </p>
          <button
            type="button"
            className="home-secondary"
            disabled={disabled}
            onClick={() => onChange({ ...configuration, repositoryWorkspaceId: null })}
          >
            Use default repository
          </button>
        </>
      )}
    </div>
  );
}
