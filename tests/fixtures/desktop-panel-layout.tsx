import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { DesktopShell } from '../../frontend/src/components/DesktopShell';
import { MobileShell } from '../../frontend/src/components/MobileShell';
import { TextBubble } from '../../frontend/src/components/MessageBubble';
import { ChatInput } from '../../frontend/src/components/ChatInput';
import { ComposerStatusProvider } from '../../frontend/src/components/ComposerStatus';
import { ResizableSessionLayout } from '../../frontend/src/components/ResizableSessionLayout';
import { useIsDesktop } from '../../frontend/src/hooks/useMediaQuery';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/desktop.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';
import '../../frontend/src/styles/mobile-workspace.css';
import '../../frontend/src/styles/session-library.css';
import '../../frontend/src/styles/appearance.css';

const markdown =
  'Found 20 features across all statuses.\n\n| Feature | Summary |\n|---|---|\n' +
  Array.from(
    { length: 20 },
    (_, i) =>
      `| Feature ${i + 1} | Integrate and validate model servers across namespaces, with observability and compatibility for deployed environments and their supported clients. |`,
  ).join('\n');
function Fixture() {
  const desktop = useIsDesktop();
  const [preview, setPreview] = useState(false);
  const chat = (
    <ComposerStatusProvider>
      <div className={desktop ? 'desktop-chat-center workspace-chat' : 'chat-page workspace-chat'}>
        <div className="conversation-heading">
          <h1>Chat</h1>
          <button type="button" onClick={() => setPreview(!preview)}>
            Toggle preview
          </button>
        </div>
        {preview ? (
          <ResizableSessionLayout
            preview={<aside className="session-inspector">Conversation preview</aside>}
          >
            <div className="session-list-scroll">Conversation list</div>
          </ResizableSessionLayout>
        ) : (
          <div className="chat-messages">
            <TextBubble content={markdown} timestamp={1794236400000} />
          </div>
        )}
        <ChatInput onSend={() => false} onStop={() => {}} />
      </div>
    </ComposerStatusProvider>
  );
  return (
    <MobileShell>
      {desktop ? (
        <DesktopShell
          left={
            <div className="session-panel">
              <h2>Conversations</h2>
              <p>A retained conversation with a longer title</p>
            </div>
          }
          center={chat}
          right={
            <div className="context-panel">
              <h2>Resources</h2>
              <p>Context and files stay available.</p>
            </div>
          }
        />
      ) : (
        chat
      )}
    </MobileShell>
  );
}
createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={['/chat/layout-fixture']}>
    <Fixture />
  </MemoryRouter>,
);
