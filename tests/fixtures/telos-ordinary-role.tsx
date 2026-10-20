import { sha256Hex } from '../../frontend/src/lib/browser-crypto';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { useRef, useState } from 'react';
import { TelosRoleSetup } from '../../frontend/src/components/TelosRoleSetup';
import { ChatInput, type ChatInputDraftControl } from '../../frontend/src/components/ChatInput';
import { localInventoryFixture } from '../../frontend/src/test-utils/local-inventory-fixture';
import { createChatRuntimeSelection } from '../../frontend/src/lib/chat-runtime-selection';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/home.css';
import '../../frontend/src/styles/session-library.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';

// Isolated actual setup + ordinary composer. Full shell/Quick sheet acceptance
// remains in telos-role-setup.spec.ts; this fixture supplies configuration only.
const inventory = localInventoryFixture();
inventory.agentProfiles[0].definition.name = 'People-work helper';
inventory.agentProfiles[0].contentHash = sha256Hex(
  JSON.stringify(inventory.agentProfiles[0].definition),
);
const runtime = {
  intent: {
    ...createChatRuntimeSelection(),
    execution: { location: 'local' as const, targetId: 'mac' },
    capabilityRevision: inventory.capabilityRevision,
    account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' },
    accountReference: inventory.accounts[0].account,
    agentProfile: { profileId: 'agent', revision: 1 },
  },
  inventory,
  reason: undefined,
};
function Fixture() {
  const draft = useRef<ChatInputDraftControl | null>(null);
  const [bound, setBound] = useState('');
  return (
    <MemoryRouter>
      <main className="chat-page workspace-chat">
        <div className="chat-area">
          <TelosRoleSetup
            intent={{ itemId: 'item', role: 'lead', mode: 'assign' }}
            runtime={runtime as never}
            mode="agent"
            draftId="ordinary-recovery-fixture"
            onBound={setBound}
            onLocked={() => {}}
            beforeConfirm={() => draft.current?.flush?.() === true}
          />
          {bound && <p role="status">Bound {bound}</p>}
        </div>
        <div className="conversation-composer">
          <ChatInput
            running={false}
            onSend={() => false}
            onStop={() => {}}
            draftStorageKey="ordinary-recovery-fixture-composer"
            draftControl={draft}
          />
        </div>
      </main>
    </MemoryRouter>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
