import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { SessionResourcesDialog } from '../../frontend/src/components/SessionResourcesDialog';
import { SessionAccess } from '../../frontend/src/components/SessionAccess';
import { ChatExecutionPicker } from '../../frontend/src/components/ChatExecutionPicker';
import { multiRuntimeInventoryFixture } from '../../frontend/src/test-utils/multi-runtime-inventory-fixture';
import { createChatRuntimeSelection } from '../../frontend/src/lib/chat-runtime-selection';
import type { TokensState } from '@mitzo/client';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';
const inventory = multiRuntimeInventoryFixture();
inventory.routes[0].location = 'local';
function Fixture() {
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <main className="workspace-page">
      <h1>Chat controls</h1>
      <textarea aria-label="Draft" defaultValue="Keep my message" />
      <SessionAccess sessionId="fixture" />
      <SessionResourcesDialog
        sessionId="fixture"
        messages={[
          {
            messageId: 'a',
            role: 'assistant',
            blocks: [
              { blockId: 't', blockType: 'text', content: 'Report: https://example.com/report' },
              {
                blockId: 'r',
                blockType: 'tool_use',
                toolName: 'Read',
                content: '',
                toolResult: 'https://api.example.com/raw https://avatars.example.com/image',
              },
            ],
          },
        ]}
        selectedContextBlocks={selected}
        draftImages={[]}
        onAddImages={() => {}}
        onRemoveImage={() => {}}
        onToggleContextBlock={(name) =>
          setSelected((previous) =>
            previous.includes(name)
              ? previous.filter((item) => item !== name)
              : [...previous, name],
          )
        }
        tokenState={
          {
            agentContext: 80000,
            tokenLimits: {
              model: 'fixture',
              source: 'runtime',
              contextWindow: 200000,
              stale: false,
            },
          } as TokensState
        }
      />
      <ChatExecutionPicker
        presentation="settings"
        runtime={
          {
            visible: true,
            inventory,
            update: () => {},
            intent: {
              ...createChatRuntimeSelection(),
              account: { accountId: 'personal', model: 'luna-fixture' },
              accountReference: inventory.accounts[0].account,
              execution: { location: 'local', targetId: 'mac' },
            },
          } as never
        }
      />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <Fixture />
  </MemoryRouter>,
);
