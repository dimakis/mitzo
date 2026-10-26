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
  const [failed, setFailed] = useState(true);
  const [selection, setSelection] = useState({
    accountId: 'work',
    model: 'luna',
    reasoningEffort: 'low' as string | null,
  });
  const settings = chatModelSettings({
    activeSessionId: 'chat',
    sessionId: 'chat',
    roleSetupLocked: false,
    localBound: true,
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
            sessionId="chat"
            preferredModel="luna"
            onChange={() => {}}
            lockAccount
            disabled={!!settings.disabledReason}
            disabledReason={settings.disabledReason}
            notice={settings.notice}
            onRetry={() => setFailed(false)}
            controlled={{
              selection,
              accounts: [
                {
                  id: 'work',
                  label: 'Work',
                  models: [
                    { id: 'luna', label: 'Luna', reasoningEfforts: ['low', 'high'] },
                    { id: 'luna-next', label: 'Luna next', reasoningEfforts: ['low', 'high'] },
                  ],
                },
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
