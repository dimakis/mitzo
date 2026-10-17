import { useEffect, useState } from 'react';
import { onKeyboardToggle } from '../../frontend/src/lib/keyboard';
import { createRoot } from 'react-dom/client';
import { SymposiumConversation } from '../../frontend/src/components/SymposiumConversation';
import { ChatInput } from '../../frontend/src/components/ChatInput';
import { UiIcon } from '../../frontend/src/components/UiIcon';
import { WorkspaceControls } from '../../frontend/src/components/WorkspaceControls';
import { AgentSettingsFields } from '../../frontend/src/components/AgentSettingsPicker';
import { AccountModelPicker } from '../../frontend/src/components/AccountModelPicker';
import type { WorkspaceSummary } from '../../frontend/src/types/workspace';
import { HomeDialog } from '../../frontend/src/components/HomeDialog';
import { DesktopShell } from '../../frontend/src/components/DesktopShell';
import { StatusBar } from '../../frontend/src/components/StatusBar';
import { MemoryRouter } from 'react-router-dom';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/desktop.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';

const field = (label: string, values: string[]) => (
  <label>
    {label}
    <select aria-label={label}>
      {values.map((value) => (
        <option key={value}>{value}</option>
      ))}
    </select>
  </label>
);
function Surface() {
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [profileTarget, setProfileTarget] = useState<HTMLDivElement | null>(null);
  const profileMode = new URLSearchParams(window.location.search).get('recovery') === 'profiles';
  const [sends, setSends] = useState(0);
  const [location, setLocation] = useState('openshell');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [summary, setSummary] = useState<WorkspaceSummary | null>(null);
  const desktop = window.matchMedia('(min-width: 768px)').matches;
  useEffect(() => onKeyboardToggle(setKeyboardOpen), []);
  const center = profileMode ? (
    <div className={desktop ? 'desktop-chat-center workspace-chat' : 'chat-page workspace-chat'}>
      <WorkspaceControls
        title="Profile drafts"
        status="Ready"
        agent="Default Mitzo"
        settings={<p>Current chat settings</p>}
      >
        <div ref={setProfileTarget} />
      </WorkspaceControls>
      <SymposiumConversation
        sessionId="fixture"
        ordinaryConfirmed
        profileToolsTarget={profileTarget}
        chat={{
          messages: [],
          current: null,
          running: false,
          permission: null,
          onPermissionRespond: () => {},
        }}
        ordinaryComposer={<ChatInput onSend={() => true} onStop={() => {}} running={false} />}
      />
    </div>
  ) : (
    <div
      className={
        desktop
          ? `desktop-chat-center workspace-chat${!sends ? ' chat-page--new' : ''}`
          : `chat-page workspace-chat${!sends ? ' chat-page--new' : ''}${keyboardOpen ? ' keyboard-open' : ''}`
      }
    >
      <WorkspaceControls
        title={sends ? 'Conversation' : 'New chat'}
        agent="Default Mitzo"
        status="Ready"
        summary={summary}
        actions={
          <button type="button" className="home-secondary">
            Access
          </button>
        }
        settings={
          <AgentSettingsFields
            agent={field('Agent', ['Default Mitzo', 'Repository helper'])}
            accountModel={
              <AccountModelPicker
                sessionId={null}
                preferredModel="luna"
                presentation="settings"
                onChange={() => {}}
                onSummaryChange={setSummary}
              />
            }
            execution={
              <div className="agent-execution-settings">
                <strong>Run on</strong>
                <div className="agent-execution-cards" role="group" aria-label="Run on">
                  <button
                    type="button"
                    className="agent-execution-card"
                    aria-pressed={location === 'openshell'}
                    onClick={() => setLocation('openshell')}
                  >
                    <span className="openshell-brand" aria-hidden="true" /> OpenShell
                  </button>
                  <button
                    type="button"
                    className="agent-execution-card"
                    aria-pressed={location === 'local'}
                    onClick={() => setLocation('local')}
                  >
                    <UiIcon name="laptop" /> Local Mac
                  </button>
                </div>
              </div>
            }
          />
        }
      >
        <div className="workspace-session-actions">
          <button type="button">Collaborate</button>
          <button type="button" onClick={() => setReviewOpen(true)}>
            Review findings
          </button>
        </div>
      </WorkspaceControls>
      <main className="chat-messages">
        <h2>What are we working on?</h2>
      </main>
      <div className={`conversation-composer${!sends ? ' conversation-composer--new' : ''}`}>
        <ChatInput
          onSend={() => {
            setSends((count) => count + 1);
            return true;
          }}
          onStop={() => {}}
          running={false}
          sendLabel="Start session"
          collaboration={
            <button type="button" aria-label="Symposium collaboration">
              <UiIcon name="agents" />
            </button>
          }
        />
        <output data-testid="sent-count" hidden>
          {sends}
        </output>
      </div>
    </div>
  );
  return (
    <>
      {desktop ? (
        <DesktopShell
          center={center}
          statusBar={<StatusBar connected sessionId="fixture-session" branch="session/fixture" />}
        />
      ) : (
        center
      )}
      {reviewOpen && (
        <HomeDialog title="Review findings" onClose={() => setReviewOpen(false)}>
          Review details
        </HomeDialog>
      )}
      {!desktop && (
        <nav className="workspace-tabs" aria-label="Main navigation">
          Today · Chats · Inbox · Work · More
        </nav>
      )}
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={['/chat']}>
    <Surface />
  </MemoryRouter>,
);
