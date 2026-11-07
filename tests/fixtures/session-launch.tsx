import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { SessionLaunchConfig, SessionLaunchRecord } from '@mitzo/protocol';
import {
  SessionLaunchCards,
  SessionLaunchOrigin,
} from '../../frontend/src/components/SessionLaunchCards';
import { localInventoryFixture } from '../../frontend/src/test-utils/local-inventory-fixture';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace-chat.css';
import '../../frontend/src/styles/motion.css';

const inventory = localInventoryFixture();
const configuration: SessionLaunchConfig = {
  version: 1,
  runtime: {
    version: 1,
    account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'high' },
    accountReference: inventory.accounts[0].account,
    agentProfile: { profileId: 'agent', revision: 1 },
    execution: { location: 'local', targetId: 'mac' },
  },
  mode: 'agent',
  isolation: true,
  repositoryWorkspaceId: null,
  contextBlocks: [],
  extraTools: [],
};
const initial: SessionLaunchRecord = {
  proposalId: 'b391d65c-33c8-4ea4-a38e-84385256bb8d',
  requestId: '07eb5281-4a58-4287-97c5-6b0a92c3e9a0',
  sourceSessionId: 'origin',
  title: 'Approval notifications and a long conversation title for narrow screens',
  prompt:
    'Continue approval notification work. Check the existing handoff and reconcile actual state before continuing.',
  configuration,
  revision: 1,
  state: 'pending',
  childSessionId: null,
  createdAt: 1793959200000,
  updatedAt: 1793959200000,
};
function Fixture() {
  const [record, setRecord] = useState(initial);
  const observe = async () => {
    const response = await fetch('/fixture-receipt');
    setRecord({ ...initial, ...(await response.json()) });
  };
  return (
    <main className="fixture-main">
      <SessionLaunchOrigin
        origin={{ sessionId: 'origin', title: 'Session implementation discussion' }}
      />
      <label>
        Original chat draft
        <textarea defaultValue="Keep my original chat draft" />
      </label>
      <SessionLaunchCards requests={[record]} onUpdate={observe} />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <Fixture />
  </MemoryRouter>,
);
