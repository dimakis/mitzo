import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AccountModelPicker } from '../../frontend/src/components/AccountModelPicker';
import { WorkspaceControls } from '../../frontend/src/components/WorkspaceControls';
import { chatModelSettings } from '../../frontend/src/lib/chat-model-settings';
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
createRoot(document.getElementById('root')!).render(<Fixture />);
