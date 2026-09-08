import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { MitzoLogo } from '../src/components/MitzoLogo';
import { SessionTray } from '../src/components/SessionTray';
import type { FinishedMessage } from '../src/types/chat';
import '../src/styles/global.css';

const messages: FinishedMessage[] = [
  {
    messageId: 'user-preview',
    role: 'user',
    blocks: [{ blockId: 'prompt', blockType: 'text', content: 'Build the resource tray' }],
    contextBlocks: ['boot-context'],
  },
  {
    messageId: 'assistant-preview',
    role: 'assistant',
    blocks: [
      {
        blockId: 'preview-link',
        blockType: 'text',
        content: 'Preview available at http://localhost:3196',
      },
      {
        blockId: 'preview-file',
        blockType: 'tool_use',
        content: '',
        toolName: 'Codex App Tools',
        rawInput: { type: 'write', path: '/workspace/session-tray.tsx' },
      },
    ],
  },
];

function Preview() {
  const [context, setContext] = useState(['boot-context']);

  return (
    <main className="tray-preview-page">
      <SessionTray
        messages={messages}
        current={null}
        bootContext={{
          source: 'contexgin',
          sourceCount: 2,
          tokenCount: 1840,
          tokenBudget: 4000,
          sources: [
            { path: 'memory/Profile/Identity.md', kind: 'profile' },
            { path: 'AGENTS.md', kind: 'constitution' },
          ],
          included: [],
          trimmed: [],
        }}
        sessionContext="Add a swipeable top resources tray to Mitzo."
        selectedContextBlocks={context}
        draftImages={[]}
        onToggleContextBlock={(name) =>
          setContext((value) =>
            value.includes(name) ? value.filter((item) => item !== name) : [...value, name],
          )
        }
        onAddImages={() => undefined}
        onRemoveImage={() => undefined}
      />
      <header className="chat-header tray-preview-toolbar">
        <MitzoLogo />
        <span className="chat-header-offline">!</span>
        <div className="mode-pills">
          <button className="mode-pill">Ask</button>
          <button className="mode-pill mode-pill--active">Agent</button>
          <button className="mode-pill">Auto</button>
        </div>
        <button className="session-close-btn">×</button>
        <button className="voice-toggle">🔇</button>
      </header>
      <div className="chat-account-bar">
        <span>Personal ChatGPT · DEV</span>
        <button>Rename</button>
        <span className="chat-model-select">GPT-5.6 Luna</span>
      </div>
      <div className="tray-preview-chat">
        <p>Session resources stay out of the conversation until you pull them down.</p>
      </div>
      <div className="chat-input">
        <div className="chat-input-row">
          <textarea className="chat-input-field" placeholder="Message Mitzo..." rows={1} />
          <button className="chat-input-btn chat-input-btn--send" aria-label="Send message">
            ↑
          </button>
        </div>
      </div>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MemoryRouter>
      <Preview />
    </MemoryRouter>
  </StrictMode>,
);
