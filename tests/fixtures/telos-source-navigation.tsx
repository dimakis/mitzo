import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, useParams, useSearchParams } from 'react-router-dom';
import type { FinishedMessage } from '../../frontend/src/types/chat';
import { TelosItemSources } from '../../frontend/src/components/TelosItemSources';
import { TelosSourceWorkLink } from '../../frontend/src/components/TelosSourceWorkLink';
import { TelosSourceNavigationProvider } from '../../frontend/src/hooks/TelosSourceNavigation';
import { WorkspaceControls } from '../../frontend/src/components/WorkspaceControls';
import { ChatArea } from '../../frontend/src/components/ChatArea';
import { ChatInput } from '../../frontend/src/components/ChatInput';
import { WorkOutputs } from '../../frontend/src/components/WorkOutputs';
import { DesktopShell } from '../../frontend/src/components/DesktopShell';
import { MobileShell } from '../../frontend/src/components/MobileShell';
import { useIsDesktop } from '../../frontend/src/hooks/useMediaQuery';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/desktop.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';
import '../../frontend/src/styles/workspace-work.css';
import '../../frontend/src/styles/session-library.css';
function OriginalChat() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [search] = useSearchParams();
  const [messages, setMessages] = useState<FinishedMessage[]>([]);
  useEffect(() => {
    const c = new AbortController();
    void fetch('/fixture-messages', { signal: c.signal })
      .then((r) => r.json())
      .then((m) => {
        if (!c.signal.aborted) setMessages(m);
      });
    return () => c.abort();
  }, []);
  return (
    <TelosSourceNavigationProvider
      sessionId={sessionId!}
      request={{
        conversationId: sessionId!,
        itemId: search.get('telosItem')!,
        snapshotId: search.get('telosSource')!,
      }}
    >
      <div className="chat-page workspace-chat">
        <WorkspaceControls
          title="Studio planning"
          agent="Planning advisor"
          status="Ready"
          summary={{ profile: 'Offline fixture account', model: 'Luna fixture', thinking: 'High' }}
          settings={<p>Ordinary settings retained</p>}
        >
          <span />
        </WorkspaceControls>
        <TelosSourceWorkLink />
        <ChatArea
          sessionId={sessionId}
          messages={messages}
          current={null}
          running={false}
          permission={null}
          onPermissionRespond={() => {}}
        />
        <ChatInput
          onSend={() => false}
          onStop={() => {}}
          running={false}
          sessionId={sessionId}
          messages={messages}
        />
      </div>
    </TelosSourceNavigationProvider>
  );
}
function Fixture() {
  const desktop = useIsDesktop();
  const pages = (
    <Routes>
      <Route path="/chat/:sessionId" element={<OriginalChat />} />
      <Route
        path="*"
        element={
          <div className="workspace-work">
            <h1>Home studio</h1>
            <TelosItemSources itemId="studio" legacySources={[]} onOpenExternal={() => {}} />
            <WorkOutputs itemId="studio" />
          </div>
        }
      />
    </Routes>
  );
  return <MobileShell>{desktop ? <DesktopShell center={pages} /> : pages}</MobileShell>;
}
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <Fixture />
  </BrowserRouter>,
);
