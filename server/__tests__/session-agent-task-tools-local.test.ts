import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionRegistry } from '@mitzo/harness';
import { sessionAgentTaskTools } from '../session-agent-task-tools.js';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import { SymposiumProfileProposalStore } from '../symposium-profile-proposals.js';
import { bindAgentToolSelection } from '../agent-tool-selection.js';
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});
it('requires interactive operator on local tools and retains durable verified-call proposals without saving tasks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-task-tools-'));
  roots.push(root);
  vi.stubEnv('REPO_PATH', root);
  const registry = new SessionRegistry();
  registry.register('verified:chat', {
    transport: { send() {}, isOpen: () => true },
    abortController: new AbortController(),
    sessionId: 'chat',
    mode: 'agent',
    sessionAllowList: new Set(),
  });
  const session = registry.get('verified:chat')!;
  const tools = sessionAgentTaskTools(
    'chat',
    session,
    registry,
    '',
    async () => {},
    () => {},
  );
  const input = {
    taskId: 'daily',
    expectedRevision: 0,
    definition: {
      name: 'Daily',
      objective: '',
      profile: { profileId: 'trace', revision: 3, contentHash: 'a'.repeat(64) },
      execution: null,
      workspace: null,
      schedule: null,
      notificationPolicy: 'results',
      outputPolicy: 'session',
    },
  };
  const signal = new AbortController().signal;
  const call = { turnId: 'turn', callId: 'call' };
  expect((await tools.execute('AgentProposeTask', input, signal, call))?.isError).toBe(true);
  expect(existsSync(join(root, '.mitzo'))).toBe(false);
  const unbind = bindAgentLibraryTransport('verified', {
    id: 'test-task-login',
    expiresAt: Date.now() + 60000,
  } as never);
  try {
    const created = await tools.execute('AgentProposeTask', input, signal, call);
    expect(created?.isError).toBe(false);
    const proposals = new SymposiumProfileProposalStore(join(root, '.mitzo', 'events.db'));
    try {
      expect(proposals.listTaskProposals('user', 'chat')).toHaveLength(1);
      expect(await tools.execute('AgentProposeTask', input, signal, call)).toEqual(created);
      expect(
        (
          await tools.execute(
            'AgentProposeTask',
            { ...input, definition: { ...input.definition, name: 'Changed' } },
            signal,
            call,
          )
        )?.isError,
      ).toBe(true);
      bindAgentToolSelection(session, { tools: [] } as never);
      expect((await tools.execute('AgentReadTasks', { action: 'list' }, signal))?.isError).toBe(
        true,
      );
    } finally {
      proposals.close();
    }
  } finally {
    unbind();
    registry.dispose();
  }
});
