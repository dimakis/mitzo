import { useEffect, useState } from 'react';
import { initializeChatStorage } from '../../frontend/src/lib/large-chat-storage';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { SessionLaunchConfig } from '@mitzo/protocol';
import { useNewChatDraft } from '../../frontend/src/hooks/useNewChatDraft';
import { SessionLaunchConfigEditor } from '../../frontend/src/components/SessionLaunchConfigEditor';
import { SessionLaunchDefaultsControl } from '../../frontend/src/components/SessionLaunchDefaultsControl';
import { WorkspaceControls } from '../../frontend/src/components/WorkspaceControls';
import { ChatInput } from '../../frontend/src/components/ChatInput';
import {
  unsupportedSessionExtraToolsReason,
  unsupportedSessionContextReason,
} from '../../frontend/src/lib/session-launch-defaults';
import { localInventoryFixture } from '../../frontend/src/test-utils/local-inventory-fixture';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace-chat.css';
import '../../frontend/src/styles/motion.css';
import '../../frontend/src/components/SessionLaunchCards.css';

const initial: SessionLaunchConfig = {
  version: 1,
  runtime: {
    version: 1,
    account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'high' },
    accountReference: localInventoryFixture().accounts[0].account,
    agentProfile: { profileId: 'agent', revision: 1 },
    execution: { location: 'openshell', targetId: null },
  },
  mode: 'agent',
  isolation: true,
  repositoryWorkspaceId: null,
  contextBlocks: [],
  extraTools: [],
};
function Fixture() {
  const [generation, setGeneration] = useState(0);
  const owner = useNewChatDraft(null, generation, true);
  const [configuration, setConfiguration] = useState(initial);
  useEffect(() => {
    if (!owner.defaultsApplied) {
      setConfiguration(initial);
      return;
    }
    const settings = owner.draft.settings;
    setConfiguration({
      version: 1,
      runtime: {
        ...settings.runtimeSelection!,
        account: settings.runtimeSelection!.account as SessionLaunchConfig['runtime']['account'],
      },
      mode: settings.mode,
      isolation: settings.isolation,
      repositoryWorkspaceId: settings.savedRepositoryWorkspaceId ?? null,
      contextBlocks: owner.draft.contextBlocks,
      extraTools: (new URLSearchParams(settings.search).get('extraTools') ?? '')
        .split(',')
        .filter(Boolean),
    });
  }, [owner.draft.id, owner.defaultsRevision]);
  // Configuration excludes the inventory observation kept by the runtime pickers.
  const publicConfiguration = {
    ...configuration,
    runtime: {
      version: 1 as const,
      account: configuration.runtime.account,
      accountReference: configuration.runtime.accountReference,
      agentProfile: configuration.runtime.agentProfile,
      execution: configuration.runtime.execution,
    },
  };
  return (
    <main className="fixture-main">
      <h1>New chat defaults</h1>
      <button
        type="button"
        className="home-secondary"
        onClick={() => setGeneration((value) => value + 1)}
      >
        New chat
      </button>
      <WorkspaceControls
        status="Ready"
        settings={
          <SessionLaunchDefaultsControl
            configuration={publicConfiguration}
            defaults={owner.defaults}
          />
        }
      >
        {null}
      </WorkspaceControls>
      {owner.defaultsHydrating ? (
        <p role="status">Loading saved agent configuration…</p>
      ) : (
        <>
          <section className="session-launch-form" aria-label="Agent configuration">
            <SessionLaunchConfigEditor
              configuration={publicConfiguration}
              onChange={setConfiguration}
            />
          </section>
          <ChatInput
            savedChatDraft={owner.draft}
            running={false}
            onStop={() => {}}
            onSend={() => false}
            sendDisabledReason={
              unsupportedSessionExtraToolsReason(configuration.extraTools.join(','), true) ??
              unsupportedSessionContextReason(configuration.contextBlocks, true) ??
              'Offline preview'
            }
          />
        </>
      )}
      <output data-testid="configuration" hidden>
        {JSON.stringify(publicConfiguration)}
      </output>
      <output data-testid="draft" hidden>
        {JSON.stringify(owner.draft)}
      </output>
    </main>
  );
}
void initializeChatStorage().then(() => {
  createRoot(document.getElementById('root')!).render(
    <MemoryRouter>
      <Fixture />
    </MemoryRouter>,
  );
});
