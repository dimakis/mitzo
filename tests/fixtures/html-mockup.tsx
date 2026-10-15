import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { TextBubble } from '../../frontend/src/components/MessageBubble';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';

createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={['/chat/mockup']}>
    <main style={{ padding: 'var(--page-gutter)' }}>
      <TextBubble
        content={'[Explore the task board](/workspace/task-board.html)'}
        artifactSessionId="mockup"
      />
      <TextBubble content={'[Retry example](/workspace/retry.html)'} artifactSessionId="mockup" />
      <TextBubble content={'[Empty example](/workspace/empty.html)'} artifactSessionId="mockup" />
    </main>
  </MemoryRouter>,
);
