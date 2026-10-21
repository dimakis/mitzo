import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { StreamingBlock } from '@mitzo/protocol';
import { ToolPill } from '../../frontend/src/components/ToolPill';
import { ToolGroup } from '../../frontend/src/components/ToolGroup';
import { AgentActivity } from '../../frontend/src/components/AgentActivity';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';
import '../../frontend/src/styles/motion.css';

function Fixture() {
  const [phase, setPhase] = useState<'running' | 'interrupted' | 'reply'>('running');
  const owned: StreamingBlock = {
    blockId: 'owned-call',
    blockType: 'tool_use',
    content: '',
    done: false,
    toolName: 'Bash',
    toolInput: 'review the retained command',
    ...(phase !== 'running' ? { toolInterrupted: true } : {}),
    ...(phase === 'reply' ? { toolResult: 'Late real output' } : {}),
  };
  const web: StreamingBlock = {
    ...owned,
    blockId: 'web-call',
    toolName: 'RequestWebAccess',
    toolInput: JSON.stringify({ operation: 'fetch', url: 'https://example.test/review' }),
    ...(phase === 'reply'
      ? { toolResult: 'External source (untrusted): Reviewed web output' }
      : {}),
  };
  const sibling: StreamingBlock = {
    blockId: 'independent-call',
    blockType: 'tool_use',
    content: '',
    done: false,
    toolName: 'Read',
    toolInput: 'independent work',
  };
  return (
    <MemoryRouter>
      <main className="workspace-chat">
        <button className="home-secondary" onClick={() => setPhase('interrupted')}>
          Show retained interruption
        </button>
        <button className="home-secondary" onClick={() => setPhase('reply')}>
          Show late real reply
        </button>
        <section aria-label="Owned command">
          <ToolPill block={owned} />
        </section>
        <section aria-label="Owned web request">
          <ToolPill block={web} />
        </section>
        <section aria-label="Mixed tool group">
          <ToolGroup tools={[owned, sibling]} />
        </section>
        <AgentActivity
          rows={[
            {
              key: 'owned',
              scope: 'original-seat',
              block: owned,
              streaming: true,
              attribution: <span>Original seat</span>,
              value: <ToolPill block={owned} />,
            },
          ]}
          replied={false}
        />
      </main>
    </MemoryRouter>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
