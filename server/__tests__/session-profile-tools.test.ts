import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionRegistry } from '@mitzo/harness';
import { sessionCredentialTools } from '../session-credential-tools.js';
import { SymposiumProfileProposalStore } from '../symposium-profile-proposals.js';
import { AgentLibraryStore } from '../agent-library-store.js';
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('creates a durable draft, deduplicates retries, and saves into the Agent Library through user review', async () => {
  const root = mkdtempSync(join(tmpdir(), 'profile-builder-'));
  roots.push(root);
  vi.stubEnv('REPO_PATH', root);
  const registry = new SessionRegistry();
  registry.register('client', {
    transport: { send() {}, isOpen: () => true },
    abortController: new AbortController(),
    mode: 'agent',
    sessionId: 'chat',
    cwd: root,
    sessionAllowList: new Set(),
  });
  const session = registry.get('client')!;
  const tools = sessionCredentialTools('chat', session, registry);
  const definition = {
    name: 'Trace',
    descriptor: 'The diagnostician',
    role: 'agent',
    instructions: 'Prove root cause with evidence.',
    expectedOutput: 'Diagnosis and next step',
    acceptanceCriteria: ['Cite evidence'],
    modelPolicyRole: 'agent',
  };
  const signal = new AbortController().signal;
  const identity = { turnId: 'turn', callId: 'call' };
  const first = await tools.execute('SymposiumProposeProfile', { definition }, signal, identity);
  expect(first?.isError).toBe(false);
  expect(await tools.execute('SymposiumProposeProfile', { definition }, signal, identity)).toEqual(
    first,
  );
  const proposals = new SymposiumProfileProposalStore(join(root, '.mitzo', 'events.db'));
  const library = new AgentLibraryStore(join(root, '.mitzo', 'events.db'));
  try {
    const pending = proposals.listPending('user', 'chat');
    expect(pending).toHaveLength(1);
    expect(library.list('user').versions).toEqual([]);
    const published = proposals.save('user', 'chat', pending[0].proposalId, {
      profileId: 'trace',
      expectedRevision: 0,
      definition,
    });
    expect(library.version('user', 'trace', 1)).toEqual(published);
    const read = await tools.execute(
      'SymposiumReadProfiles',
      { action: 'get', profileId: 'trace', revision: 1 },
      signal,
      identity,
    );
    expect(JSON.parse(read!.content)).toEqual(published);
    const list = await tools.execute('SymposiumReadProfiles', { action: 'list' }, signal, identity);
    expect(JSON.parse(list!.content).profiles[0].name).toBe('Trace');
    expect(await tools.execute('SaveProfile', {}, signal, identity)).toBeUndefined();
    session.abortController.abort();
    expect(
      (
        await tools.execute('SymposiumProposeProfile', { definition }, signal, {
          ...identity,
          callId: 'late',
        })
      )?.isError,
    ).toBe(true);
    expect(proposals.listPending('user', 'chat')).toEqual([]);
  } finally {
    proposals.close();
    library.close();
    registry.dispose();
  }
});
