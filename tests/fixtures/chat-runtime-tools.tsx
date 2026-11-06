import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes, useParams, useSearchParams } from 'react-router-dom';
import { ChatInput } from '../../frontend/src/components/ChatInput';
import { chatComposerCapabilities } from '../../frontend/src/lib/chat-composer-capabilities';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace-chat.css';

function Composer() {
  const { sessionId } = useParams();
  const [params] = useSearchParams();
  const location = params.get('location') === 'openshell' ? 'openshell' : 'local';
  return (
    <main className="workspace-page">
      <div className="workspace-chat">
        <ChatInput
          sessionId={sessionId}
          draftStorageKey={sessionId ? undefined : 'runtime-tools-draft'}
          initialText={sessionId ? undefined : 'Keep this draft'}
          onSend={() => {
            throw Error('Selection must not send');
          }}
          onStop={() => {}}
          running={false}
          boundedFirstCommand={!sessionId}
          guardedConversation={!!sessionId}
          composerCapabilities={chatComposerCapabilities({
            ordinary: true,
            location,
            sessionId,
            draftId: 'runtime-tools',
            blocked: false,
          })}
        />
      </div>
    </main>
  );
}
function Terminal() {
  const [params] = useSearchParams();
  return (
    <main>
      <h1>Selected terminal destination</h1>
      <Link to={params.get('returnTo')!}>Back to chat</Link>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <Routes>
      <Route path="/chat" element={<Composer />} />
      <Route path="/chat/:sessionId" element={<Composer />} />
      <Route path="/terminal" element={<Terminal />} />
    </Routes>
  </BrowserRouter>,
);
