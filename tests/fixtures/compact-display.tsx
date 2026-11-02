import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { FileViewer } from '../../frontend/src/pages/FileViewer';
import { MobileShell } from '../../frontend/src/components/MobileShell';
import { DesktopShell } from '../../frontend/src/components/DesktopShell';
import { useIsDesktop } from '../../frontend/src/hooks/useMediaQuery';
import { ChatInput } from '../../frontend/src/components/ChatInput';
import { createChatDraft } from '../../frontend/src/lib/chat-drafts';
import { chatStorage } from '../../frontend/src/lib/large-chat-storage';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/desktop.css';
import '../../frontend/src/styles/appearance.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/mobile-workspace.css';
import '../../frontend/src/styles/workspace-chat.css';
import '../../frontend/src/styles/chat-drafts.css';
import '../../frontend/src/styles/motion.css';

const draft = createChatDraft();
// IndexedDB bootstrap makes even small screenshot drafts asynchronous in browser tests.
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=';
draft.images = [
  {
    mediaType: 'image/png',
    data: png,
    preview: `data:image/png;base64,${png}`,
  },
];
draft.text = 'Review this screenshot';
Object.assign(window, { displayStorage: chatStorage });

function Surface() {
  const { pathname } = useLocation();
  const desktop = useIsDesktop();
  if (pathname === '/files')
    return (
      <MobileShell>
        {desktop ? <DesktopShell center={<FileViewer />} /> : <FileViewer />}
      </MobileShell>
    );
  return (
    <main className="chat-page workspace-chat chat-page--new">
      <header className="chat-header">New chat</header>
      <div style={{ flex: 1 }} />
      <ChatInput running={false} onStop={() => {}} onSend={() => false} savedChatDraft={draft} />
    </main>
  );
}
const root = createRoot(document.getElementById('root')!);
function renderDisplay() {
  const preview = window as unknown as {
    compactDisplayRoute?: string;
    compactDisplayWidth?: string;
  };
  root.render(
    <MemoryRouter
      key={`${preview.compactDisplayRoute}:${preview.compactDisplayWidth}:${document.documentElement.dataset.theme}`}
      initialEntries={[preview.compactDisplayRoute ?? location.pathname + location.search]}
    >
      <Surface />
    </MemoryRouter>,
  );
}
Object.assign(window, { renderCompactDisplay: renderDisplay });
renderDisplay();
