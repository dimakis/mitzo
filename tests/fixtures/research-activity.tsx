import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ChatArea } from '../../frontend/src/components/ChatArea';
import type { FinishedMessage } from '@mitzo/protocol';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';

const messages: FinishedMessage[] = [
  {
    messageId: 'research',
    role: 'assistant',
    blocks: [
      {
        blockId: 'thought',
        blockType: 'thinking',
        content:
          '**Exploring GitHub**\n\nDetailed speculative planning belongs inside this disclosure.',
      },
      {
        blockId: 'read',
        blockType: 'tool_use',
        content: '',
        toolName: 'RequestWebAccess',
        toolId: 'read',
        toolInput: JSON.stringify({
          operation: 'fetch',
          url: 'https://api.github.com/repos/example/project/issues?per_page=10',
        }),
        toolResult: 'External source (untrusted): Selected GitHub records',
      },
      {
        blockId: 'thought2',
        blockType: 'thinking',
        content:
          '**Checking the evidence**\n\nFurther internal planning should not replace tool progress.',
      },
    ],
  },
];
function Fixture() {
  const [finished, setFinished] = useState(false);
  return (
    <MemoryRouter>
      <main className="workspace-chat">
        <button className="home-secondary" onClick={() => setFinished(true)}>
          Complete research
        </button>
        <ChatArea
          messages={
            finished
              ? [
                  ...messages,
                  {
                    messageId: 'answer',
                    role: 'assistant',
                    blocks: [
                      { blockId: 'answer', blockType: 'text', content: 'The comparison is ready.' },
                    ],
                  },
                ]
              : messages
          }
          current={null}
          running={false}
          permission={null}
          onPermissionRespond={() => {}}
        />
      </main>
    </MemoryRouter>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
