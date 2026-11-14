import './fixtures/offline-user-home.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SessionRegistry, setSkillPolicy, resolvePending } from '@mitzo/harness';
import {
  createCredentialSdkServer,
  credentialSdkPermission,
  sdkInformationInstructions,
} from '../credential-sdk-tools.js';
import { assertAgentToolRoute, bindAgentToolSelection } from '../agent-tool-selection.js';
import { ordinarySdkConnectionHelperTools } from '../ordinary-sdk-helper-registration.js';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import { EventStore } from '../event-store.js';
import { AcceptedKnowledgeSource } from '../knowledge-library-source.js';
import { KnowledgeDraftStore } from '../knowledge-draft-store.js';
import { installKnowledgeDraftRuntime } from '../session-knowledge-tools.js';
import { AgentLibraryStore } from '../agent-library-store.js';
import { getAgentTasks, closeAgentTasks } from '../agent-task-runtime.js';
import { SymposiumProfileProposalStore } from '../symposium-profile-proposals.js';

const names = [
  'SearchPastSessions',
  'ReadPastSession',
  'ReadKnowledge',
  'SaveKnowledgeDraft',
  'AgentReadTasks',
  'AgentProposeTask',
];
const prefix = 'mcp__mitzo-connections__';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  closeAgentTasks();
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function fixture(selected?: string[], mode: 'ask' | 'agent' | 'auto' = 'auto') {
  const root = mkdtempSync(join(tmpdir(), 'claude-information-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  vi.stubEnv('REPO_PATH', root);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'accepted.md'), 'Accepted library text');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const revision = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'docs', 'accepted.md'), 'DIRTY_CHECKOUT_BYTES');
  const source = new AcceptedKnowledgeSource(root, 'refs/remotes/origin/main', ['docs']);
  const drafts = new KnowledgeDraftStore(':memory:');
  cleanups.push(() => drafts.close());
  cleanups.push(
    installKnowledgeDraftRuntime(async () => ({
      source,
      store: drafts,
      sourceIdentity: 'fixture',
      refresh: async () => {},
    })),
  );
  mkdirSync(join(root, '.mitzo'));
  const library = new AgentLibraryStore(join(root, '.mitzo/events.db'));
  cleanups.push(() => library.close());
  const profileDraft = library.saveDraft('user', {
    profileId: 'fixture',
    expectedVersion: 0,
    expectedRevision: 0,
    idempotencyKey: 'draft',
    definition: {
      name: 'Fixture',
      role: 'reviewer',
      instructions: 'Offline fixture',
      expectedOutput: 'Evidence',
      acceptanceCriteria: ['Evidence'],
      modelPolicyRole: 'reviewer',
    },
  });
  const profile = library.publish('user', {
    profileId: 'fixture',
    expectedVersion: profileDraft.version,
    idempotencyKey: 'publish',
  });
  const definition = {
    name: 'Saved task',
    objective: '',
    profile: {
      profileId: profile.profileId,
      revision: profile.revision,
      contentHash: profile.contentHash,
    },
    execution: null,
    workspace: null,
    schedule: null,
    notificationPolicy: 'results',
    outputPolicy: 'session',
  };
  const task = getAgentTasks().save('user', {
    taskId: 'saved',
    expectedRevision: 0,
    idempotencyKey: 'save',
    definition,
  });
  const events = new EventStore(':memory:');
  cleanups.push(() => events.close());
  for (const id of ['chat', 'visible', 'hidden'])
    events.upsertSession({ sessionId: id, conversationSource: 'mitzo', summary: `Fixture ${id}` });
  events.hideSession('hidden');
  events.append('visible', 'user_message', { text: 'Public needle' });
  events.append('hidden', 'user_message', { text: 'HIDDEN_NEEDLE' });
  events.append('visible', 'block_delta', { blockType: 'thinking', delta: 'PRIVATE_REASONING' });
  const registry = new SessionRegistry();
  cleanups.push(() => registry.dispose());
  registry.register('owner', {
    sessionId: 'chat',
    mode,
    cwd: root,
    abortController: new AbortController(),
    sessionAllowList: new Set(),
    ownerConnectionId: 'operator',
    accountBinding: { accountId: 'claude', provider: 'anthropic', model: 'synthetic' },
  } as never);
  const session = registry.get('owner')!;
  const auth = { id: 'fixture-login', expiresAt: Date.now() + 60000 };
  const unbind = bindAgentLibraryTransport('operator', auth);
  cleanups.push(unbind);
  if (selected) {
    const profile = {
      tools: selected.map((name) => ({ id: `mitzo:${name}`, version: 1 })),
    } as never;
    assertAgentToolRoute(profile, 'claude-sdk');
    bindAgentToolSelection(session, profile, 'claude-sdk');
  }
  const state = { current: true, afterCheck: () => {} };
  const assertCurrentSync = () => {
    if (!state.current) throw Error('PRIVATE_REVOKED_DETAIL');
  };
  const server = createCredentialSdkServer(() => session.sessionId, session, registry, {
    profilesOnly: true,
    connectionBoundary: 'sdk-callback',
    historyEvents: events,
    assertCurrentSync,
    assertCurrent: async () => {
      assertCurrentSync();
      state.afterCheck();
    },
  });
  const client = new Client({ name: 'offline-information', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.instance.close();
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>).map((x) => x.text).join('');
    return { ...result, text };
  };
  return {
    root,
    source,
    drafts,
    revision,
    events,
    registry,
    session,
    state,
    auth,
    unbind,
    client,
    call,
    task,
    definition,
  };
}

it.each([{ selected: undefined }, { selected: names }])(
  'executes canonical reads through real SDK/MCP with selection $selected',
  async ({ selected }) => {
    const f = await fixture(selected);
    expect((await f.client.listTools()).tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(names),
    );
    for (const name of names) expect(ordinarySdkConnectionHelperTools).toContain(prefix + name);
    const search = await f.call('SearchPastSessions', { query: 'needle' });
    expect(search.isError).not.toBe(true);
    expect(JSON.parse(search.text).sessions).toEqual([
      expect.objectContaining({ conversationId: 'visible', snippet: 'Public needle' }),
    ]);
    const read = await f.call('ReadPastSession', { conversationId: 'visible' });
    expect(read.isError).not.toBe(true);
    expect(read.text).toContain('Public needle');
    expect(read.text).not.toMatch(/PRIVATE_REASONING|HIDDEN_NEEDLE/);
    const knowledge = await f.call('ReadKnowledge', {
      action: 'read',
      path: 'docs/accepted.md',
      revision: f.revision,
    });
    expect(knowledge.isError).not.toBe(true);
    expect(JSON.parse(knowledge.text).content).toBe('Accepted library text');
    const task = await f.call('AgentReadTasks', { action: 'get', taskId: 'saved' });
    expect(task.isError).not.toBe(true);
    expect(JSON.parse(task.text)).toEqual(f.task);
  },
);

it('stores an actual task proposal without changing the saved definition', async () => {
  const f = await fixture(names);
  const result = await f.call('AgentProposeTask', {
    taskId: 'saved',
    expectedRevision: f.task.revision,
    definition: { ...f.definition, name: 'Proposed task' },
  });
  expect(result.isError).not.toBe(true);
  expect(JSON.parse(result.text)).toMatchObject({
    status: 'awaiting_user_review',
    expectedRevision: f.task.revision,
  });
  const proposals = new SymposiumProfileProposalStore(join(f.root, '.mitzo/events.db'));
  try {
    expect(proposals.listTaskProposals('user', 'chat')).toHaveLength(1);
  } finally {
    proposals.close();
  }
  expect(getAgentTasks().read('user', 'saved')).toEqual(f.task);
  // Proposals retain the requested revision; only the human save attempts CAS.
  const stale = await f.call('AgentProposeTask', {
    taskId: 'saved',
    expectedRevision: 0,
    definition: f.definition,
  });
  expect(JSON.parse(stale.text)).toMatchObject({
    status: 'awaiting_user_review',
    expectedRevision: 0,
  });
  expect(getAgentTasks().read('user', 'saved')).toEqual(f.task);
});

it.each(['approve', 'deny', 'expire', 'cancel', 'revoke', 'source-change'] as const)(
  'routes Knowledge draft %s through the existing approval owner',
  async (decision) => {
    const f = await fixture(names);
    const cards: Record<string, unknown>[] = [];
    f.session.transport = {
      isOpen: () => true,
      send(event: Record<string, unknown>) {
        if (event.type !== 'permission_request') return;
        cards.push(event);
        queueMicrotask(() => {
          if (decision === 'cancel') {
            f.session.abortController.abort();
            return;
          }
          if (decision === 'revoke') f.unbind();
          if (decision === 'source-change')
            vi.spyOn(f.source, 'revision').mockResolvedValue('b'.repeat(40));
          const clock =
            decision === 'expire'
              ? vi.spyOn(Date, 'now').mockReturnValue(Number(event.expiresAt) + 1)
              : undefined;
          try {
            resolvePending(
              String(event.permId),
              decision === 'deny' ? 'deny' : 'once',
              undefined,
              'chat',
            );
          } finally {
            clock?.mockRestore();
          }
        });
      },
    } as never;
    const args = {
      requestId: 'a186b239-7960-4791-97fb-15c4be27da6d',
      title: 'Proposed library text',
      baseRevision: f.revision,
      documents: [{ path: 'docs/accepted.md', content: 'Proposed text' }],
    };
    expect(
      credentialSdkPermission(prefix + 'SaveKnowledgeDraft', args, 'owner', f.registry, f.session),
    ).toMatchObject({ behavior: 'allow' });
    const result = await f.call('SaveKnowledgeDraft', args);
    expect(cards).toHaveLength(1);
    if (decision === 'approve') {
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(result.text)).toMatchObject({ status: 'draft-saved', accepted: false });
      expect(f.drafts.list()).toHaveLength(1);
      expect(await f.call('SaveKnowledgeDraft', args)).toMatchObject({ text: result.text });
      expect(f.drafts.list()).toHaveLength(1);
    } else {
      expect(result.isError).toBe(true);
      expect(f.drafts.list()).toHaveLength(0);
      if (decision === 'expire') expect(result.text).toContain('approval_expired');
    }
    expect((await f.source.read('docs/accepted.md', f.revision)).content).toBe(
      'Accepted library text',
    );
  },
);

it.each(['ReadPastSession', 'AgentReadTasks'] as const)(
  'reports unexpected %s failures without exposing storage payloads',
  async (name) => {
    const f = await fixture(names);
    if (name === 'ReadPastSession')
      vi.spyOn(f.events, 'getHistoryEventPage').mockImplementationOnce(() => {
        throw Error('PRIVATE_STORAGE_DETAIL');
      });
    else
      vi.spyOn(getAgentTasks(), 'list').mockImplementationOnce(() => {
        throw Error('PRIVATE_STORAGE_DETAIL');
      });
    const result = await f.call(
      name,
      name === 'ReadPastSession' ? { conversationId: 'visible' } : { action: 'list' },
    );
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain('PRIVATE_STORAGE_DETAIL');
    expect(result.text).toContain('diagnosticId');
  },
);

it('keeps search metadata-only when the companion read capability is excluded', async () => {
  const f = await fixture(['SearchPastSessions']);
  expect(
    JSON.parse((await f.call('SearchPastSessions', { query: 'needle' })).text).sessions,
  ).toEqual([]);
  expect((await f.call('SearchPastSessions', { query: 'needle', scope: 'all' })).isError).toBe(
    true,
  );
  expect((await f.call('ReadPastSession', { conversationId: 'visible' })).isError).toBe(true);
});

it('uses exact SDK skill names for transcript search and rejects a revoked read ceiling', async () => {
  const f = await fixture(names);
  setSkillPolicy(f.registry, 'owner', [prefix + 'SearchPastSessions', prefix + 'ReadPastSession']);
  expect((await f.call('SearchPastSessions', { query: 'needle' })).text).toContain('Public needle');
  setSkillPolicy(f.registry, 'owner', [prefix + 'SearchPastSessions']);
  expect(
    JSON.parse((await f.call('SearchPastSessions', { query: 'needle' })).text).sessions,
  ).toEqual([]);
});

it.each(['ReadPastSession', 'ReadKnowledge', 'AgentReadTasks'])(
  'withholds %s after cancellation, operator expiry/revocation, or skill restriction',
  async (name) => {
    const args = name === 'ReadPastSession' ? { conversationId: 'visible' } : { action: 'list' };
    for (const change of ['skill', 'expire', 'revoke', 'cancel', 'owner'] as const) {
      const f = await fixture(names);
      if (change === 'skill') setSkillPolicy(f.registry, 'owner', []);
      if (change === 'expire') f.auth.expiresAt = 0;
      if (change === 'revoke') f.unbind();
      if (change === 'cancel') f.session.abortController.abort();
      if (change === 'owner') f.registry.remove('owner');
      const result = await f.call(name, args);
      expect(result.isError, change).toBe(true);
      expect(result.text).not.toMatch(/Public needle|Accepted library text|Saved task/);
    }
  },
);

it('rejects hidden and unregistered history and preserves snapshot pagination', async () => {
  const f = await fixture(names);
  for (const conversationId of ['hidden', 'missing'])
    expect((await f.call('ReadPastSession', { conversationId })).isError).toBe(true);
  f.events.append('visible', 'user_message', { text: 'Second public message' });
  const first = JSON.parse(
    (await f.call('ReadPastSession', { conversationId: 'visible', limit: 1 })).text,
  );
  expect(first.entries).toHaveLength(1);
  f.events.append('visible', 'user_message', { text: 'AFTER_SNAPSHOT' });
  const next = await f.call('ReadPastSession', {
    conversationId: 'visible',
    afterSeq: first.nextAfterSeq,
    throughSeq: first.throughSeq,
  });
  expect(next.text).toContain('Second public message');
  expect(next.text).not.toContain('AFTER_SNAPSHOT');
});

it('keeps excluded profiles and callback decisions closed', async () => {
  const f = await fixture([]);
  expect(sdkInformationInstructions(f.session)).toBe('');
  for (const name of names) {
    expect(
      credentialSdkPermission(prefix + name, {}, 'owner', f.registry, f.session),
    ).toMatchObject({ behavior: 'deny' });
    await expect(f.client.callTool({ name, arguments: {} })).rejects.toThrow(/Method not found/);
  }
});

it('guides only selected information outcomes and distinguishes history from controllable chats', async () => {
  const f = await fixture(names);
  const guidance = sdkInformationInstructions(f.session);
  for (const name of names) expect(guidance).toContain(name);
  expect(guidance).toContain('saved history');
  expect(guidance).not.toContain('AgentCommunication');
});
