import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { SubagentStatus } from '@mitzo/protocol';
import { SubagentCard } from '../../frontend/src/components/SubagentCard';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace-chat.css';

const statuses: SubagentStatus[] = ['running', 'completed', 'failed', 'cancelled', 'unavailable'];
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <main>
      <h1>Claude activity</h1>
      {statuses.map((status) => (
        <section key={status} aria-label={`${status} child`}>
          <SubagentCard
            subagent={{
              messageId: `child-${status}`,
              status,
              blocks: [
                {
                  blockId: `output-${status}`,
                  blockType: 'text',
                  content: 'Retained public output',
                },
              ],
              ...(status === 'unavailable'
                ? {
                    diagnostic: {
                      code: 'claude_child_stop_failed',
                      correlationId: '00000000-0000-4000-8000-000000000000',
                    } as const,
                  }
                : {}),
            }}
          />
        </section>
      ))}
      <section aria-label="Failed before output">
        <SubagentCard subagent={{ messageId: 'empty', status: 'failed', blocks: [] }} />
      </section>
      <label>
        Message draft
        <textarea defaultValue="Keep my draft" />
      </label>
    </main>
  </MemoryRouter>,
);
