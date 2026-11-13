import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AccountModelPicker } from '../../frontend/src/components/AccountModelPicker';
import { WorkspaceControls } from '../../frontend/src/components/WorkspaceControls';
import { chatModelSettings } from '../../frontend/src/lib/chat-model-settings';
import { ChatRuntimeDraftProvider } from '../../frontend/src/hooks/ChatRuntimeDraftProvider';
import { useExplicitLocalChat } from '../../frontend/src/hooks/useExplicitLocalChat';
import { runtimeModelAccounts } from '../../frontend/src/lib/chat-runtime-route';
import { prepareLocalContinuationCommand } from '../../frontend/src/lib/explicit-local-chat';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';

function Fixture() {
  const legacy = new URLSearchParams(window.location.search).has('legacy');
  const accountSwitch = new URLSearchParams(window.location.search).has('accounts');
  const [refreshed, setRefreshed] = useState(false);
  const [failed, setFailed] = useState(!legacy && !accountSwitch);
  const [selection, setSelection] = useState({
    accountId: 'work',
    model: 'luna',
    reasoningEffort: 'low' as string | null,
  });
  const settings = chatModelSettings({
    activeSessionId: 'chat',
    sessionId: 'chat',
    roleSetupLocked: false,
    localBound: !legacy,
    metadataPending: failed,
    metadataUnavailable: failed,
    commandAvailable: !failed,
    preparedFirst: false,
    repositoryLoading: false,
    briefingLocked: false,
    briefingLoading: false,
    launchSending: false,
  });
  return (
    <div className="chat-page workspace-chat">
      <WorkspaceControls
        title="Running conversation"
        status="Running"
        agent="Default Mitzo"
        settings={
          <AccountModelPicker
            presentation="settings"
            sessionId={accountSwitch ? null : 'chat'}
            preferredModel="luna"
            onChange={() => {}}
            lockAccount={!accountSwitch}
            disabled={!!settings.disabledReason}
            disabledReason={settings.disabledReason}
            notice={settings.notice}
            onRetry={() => setFailed(false)}
            controlled={{
              selection,
              onRefresh: () => setRefreshed(true),
              accounts: [
                {
                  id: 'work',
                  label: 'Work',
                  models: [
                    { id: 'luna', label: 'Luna', reasoningEfforts: ['low', 'high'] },
                    { id: 'luna-next', label: 'Luna next', reasoningEfforts: ['low', 'high'] },
                  ],
                },
                ...(accountSwitch
                  ? [
                      {
                        id: 'claude',
                        label: 'Personal Claude',
                        modelDiscovery: {
                          stale: !refreshed,
                          ...(!refreshed
                            ? {
                                failure: {
                                  code: 'claude_sign_in_unavailable' as const,
                                  diagnosticId: '566e4644-cd56-4b29-938b-586d69c850ef',
                                },
                              }
                            : {}),
                        },
                        models: [
                          {
                            id: 'sonnet',
                            label: 'Claude Sonnet 4.6',
                            reasoningEfforts: ['medium', 'high'],
                            defaultReasoningEffort: 'medium',
                          },
                          ...(refreshed
                            ? [
                                {
                                  id: 'opus',
                                  label: 'Claude Opus 4.8',
                                  reasoningEfforts: ['high', 'max'],
                                  defaultReasoningEffort: 'high',
                                },
                              ]
                            : []),
                        ],
                      },
                    ]
                  : []),
              ],
              onChange: (next) =>
                setSelection({
                  accountId: next.accountId!,
                  model: next.model,
                  reasoningEffort: next.reasoningEffort ?? null,
                }),
            }}
          />
        }
      />
      <textarea aria-label="Message draft" defaultValue="Keep my draft" />
      <output aria-label="Next message settings">
        {selection.model} / {selection.reasoningEffort}
      </output>
    </div>
  );
}
function BoundScreen({
  onPrepared,
  onRecreate,
  prepared,
}: {
  onPrepared(value: string): void;
  onRecreate(): void;
  prepared: string;
}) {
  const runtime = useExplicitLocalChat('bound-draft', undefined, 'bound-session', true);
  const accounts = runtimeModelAccounts(runtime.intent, runtime.inventory);
  const account = accounts.find((entry) => entry.id === runtime.intent.account?.accountId);
  return (
    <div className="chat-page workspace-chat">
      <WorkspaceControls
        title="Existing conversation"
        summary={{
          profile: account?.label ?? 'Loading account',
          model: account?.models.find((entry) => entry.id === runtime.intent.account?.model)?.label,
          thinking: runtime.intent.account?.reasoningEffort ?? undefined,
        }}
        settings={
          <AccountModelPicker
            presentation="settings"
            sessionId="bound-session"
            preferredModel="luna-fixture"
            onChange={() => {}}
            lockAccount
            disabled={!runtime.commandAvailable}
            controlled={{
              accounts,
              selection: runtime.intent.account,
              onChange: (selection) => runtime.update({ ...runtime.intent, account: selection }),
            }}
          />
        }
      />
      <button
        type="button"
        disabled={!runtime.commandAvailable}
        onClick={() => {
          const prepared = prepareLocalContinuationCommand(runtime.intent, runtime.inventory, {
            sessionId: 'bound-session',
            repositoryWorkspaceId: runtime.repositoryWorkspaceId!,
            clientMsgId: '11111111-1111-4111-8111-111111111112',
            mode: 'agent',
            text: 'Continue the task',
          });
          onPrepared(JSON.stringify(prepared.request?.selection ?? { error: prepared.reason }));
        }}
      >
        Prepare next message
      </button>
      <button type="button" onClick={onRecreate}>
        Recreate chat screen
      </button>
      <output aria-label="Frozen command settings">{prepared}</output>
    </div>
  );
}

function BoundFixture() {
  const [generation, setGeneration] = useState(0);
  const [prepared, setPrepared] = useState('');
  return (
    <ChatRuntimeDraftProvider owner="bound-session:0">
      <BoundScreen
        key={generation}
        onPrepared={setPrepared}
        onRecreate={() => setGeneration((value) => value + 1)}
        prepared={prepared}
      />
    </ChatRuntimeDraftProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  new URLSearchParams(window.location.search).has('retained') ? <BoundFixture /> : <Fixture />,
);
