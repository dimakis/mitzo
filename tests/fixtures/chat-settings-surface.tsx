import { useEffect, useState } from 'react';
import { onKeyboardToggle } from '../../frontend/src/lib/keyboard';
import { createRoot } from 'react-dom/client';
import { WorkspaceControls } from '../../frontend/src/components/WorkspaceControls';
import { AgentSettingsFields } from '../../frontend/src/components/AgentSettingsPicker';
import { HomeDialog } from '../../frontend/src/components/HomeDialog';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
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
  const [sends, setSends] = useState(0);
  const [reviewOpen, setReviewOpen] = useState(false);
  useEffect(() => onKeyboardToggle(setKeyboardOpen), []);
  return (
    <>
      <div className={`chat-page workspace-chat${keyboardOpen ? ' keyboard-open' : ''}`}>
        <div className="conversation-heading">
          <a href="#chats">‹ Chats</a>
          <h1>New chat</h1>
        </div>
        <WorkspaceControls
          agent="Default Mitzo"
          status="Ready"
          summary={{ profile: 'Personal ChatGPT', model: 'GPT-6.1-Sol', thinking: 'High' }}
          actions={
            <button type="button" className="home-secondary">
              Access
            </button>
          }
          settings={
            <AgentSettingsFields
              agent={field('Agent', ['Default Mitzo', 'Repository helper'])}
              accountModel={
                <>
                  {field('Account', ['Personal ChatGPT', 'Work'])}
                  {field('Model', ['GPT-6.1-Sol', 'Luna'])}
                  {field('Thinking level', ['High', 'Medium', 'Low'])}
                </>
              }
              execution={
                <div className="agent-execution-settings">
                  <strong>Run on</strong>
                  <div className="agent-execution-cards">
                    <button type="button" className="agent-execution-card" aria-pressed="true">
                      OpenShell
                    </button>
                    <button type="button" className="agent-execution-card" aria-pressed="false">
                      Local Mac
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
        <div className="conversation-composer">
          <div className="chat-input chat-input--compact">
            <div className="chat-input-row">
              <textarea
                className="chat-input-field"
                aria-label="Message Mitzo"
                placeholder="Message Mitzo…"
              />
              <div className="composer-toolbar">
                <button type="button" aria-label="Add attachment">
                  +
                </button>
                <button type="button" onClick={() => setSends((count) => count + 1)}>
                  Start session
                </button>
                <output data-testid="sent-count" hidden>
                  {sends}
                </output>
              </div>
            </div>
          </div>
        </div>
      </div>
      {reviewOpen && (
        <HomeDialog title="Review findings" onClose={() => setReviewOpen(false)}>
          Review details
        </HomeDialog>
      )}
      <nav className="workspace-tabs" aria-label="Main navigation">
        Today · Chats · Inbox · Work · More
      </nav>
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Surface />);
