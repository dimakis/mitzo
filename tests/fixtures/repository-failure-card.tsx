import { createRoot } from 'react-dom/client';
import { BrowserRouter, useLocation, useSearchParams } from 'react-router-dom';
import { ToolGroup } from '../../frontend/src/components/ToolGroup';
import { RepositoryChatDraftNotice } from '../../frontend/src/components/RepositoryChatDraftNotice';
import { useRepositoryChatPreparation } from '../../frontend/src/hooks/useRepositoryChatPreparation';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';

const receipt = {
  id: '8ca30b0d-3e65-4eeb-8244-f6277350818f',
  sourceConversationId: 'parent-chat',
  repository: 'example/repo',
  baseBranch: 'main',
  baseOid: 'a'.repeat(40),
  featureBranch: 'mitzo/task',
  state: 'failed',
  accountId: 'work',
  model: 'offline-fixture',
  prompt: 'Inspect the original failed repository preparation.',
  setupUrl: '/chat?repositoryPreparation=8ca30b0d-3e65-4eeb-8244-f6277350818f',
  failure: { code: 'repository_space', message: 'Free at least 3 GiB, then retry.' },
};
const tools = ['PrepareRepositoryChat', 'GetRepositoryChatPreparation'].map((toolName) => ({
  blockId: toolName,
  blockType: 'tool_use' as const,
  content: '',
  done: true,
  toolName,
  toolError: true,
  toolResult: JSON.stringify({ repositoryChat: receipt }),
}));

function Fixture() {
  const location = useLocation();
  const [search] = useSearchParams();
  const handoff = useRepositoryChatPreparation(search.get('repositoryPreparation'));
  return (
    <main className="chat-messages">
      {location.pathname === '/chat/parent-chat' ? (
        <ToolGroup tools={tools} sessionId="parent-chat" />
      ) : (
        <RepositoryChatDraftNotice handoff={handoff} />
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <Fixture />
  </BrowserRouter>,
);
