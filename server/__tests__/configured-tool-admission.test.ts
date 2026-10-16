import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { SessionRegistry } from '@mitzo/harness';
import { AgentLibraryStore } from '../agent-library-store.js';
import { EventStore } from '../event-store.js';
import { NativeResponsesStore } from '../native-responses-store.js';
import { ConfiguredToolCatalog } from '../configured-tool-catalog.js';
import { AsyncQueue } from '../async-queue.js';
const capture = vi.hoisted(() => ({
  options: undefined as
    | {
        tools: { name: string }[];
        executeTool(
          block: { id: string; name: string; input: Record<string, unknown> },
          signal: AbortSignal,
        ): Promise<{ content: string; is_error?: boolean }>;
      }
    | undefined,
}));
vi.mock('../native-responses-runner.js', () => ({
  NativeResponsesRunner: class {
    constructor(options: Record<string, unknown>) {
      capture.options = options as unknown as NonNullable<typeof capture.options>;
    }
    interrupt() {}
    waitUntilIdle = async () => {};
  },
}));
import { openResponsesChat } from '../responses-chat-session.js';

it.each(['openai', 'google-vertex'] as const)(
  'publishes one duplicate-name source, filters every call, and cold resumes on %s',
  async (provider) => {
    const root = mkdtempSync(join(tmpdir(), 'configured-admission-'));
    const files = (name: string) => join(root, `${name}.db`);
    let library = new AgentLibraryStore(files('library'));
    let events = new EventStore(files('events'));
    let privateStore = new NativeResponsesStore(files('private'));
    let catalog = new ConfiguredToolCatalog(files('catalog'));
    const configs = {
      one: { command: 'fake-one', librarySourceId: '11111111-1111-4111-8111-111111111111' },
      two: { command: 'fake-two', librarySourceId: '22222222-2222-4222-8222-222222222222' },
    };
    const peers = {
      'fake-one': vi.fn(async () => ({ content: [{ type: 'text', text: 'correct peer' }] })),
      'fake-two': vi.fn(),
    };
    const close = vi.fn(async () => {});
    let schema: Record<string, unknown> = { type: 'object' };
    const names = ['search', 'unselected'];
    let revoked = false;
    const options = {
      cwd: root,
      env: {},
      signal: new AbortController().signal,
      readSources: () => configs,
      assertRuntimeCurrent: () => {
        if (revoked) throw Error('Source authority revoked');
      },
      connect: vi.fn(async (config: { command: string }) => ({
        listTools: async () => ({ tools: names.map((name) => ({ name, inputSchema: schema })) }),
        callTool: peers[config.command as keyof typeof peers],
        close,
      })),
    };
    const registry = new SessionRegistry();
    const aborts: AbortController[] = [];
    const sessions: { close(): void }[] = [];
    async function open(resume: boolean, omitSourceEnv = false) {
      const abort = new AbortController();
      aborts.push(abort);
      const clientId = 'client';
      registry.register(clientId, {
        transport: { send: () => {}, isOpen: () => true },
        abortController: abort,
        mode: 'auto',
        sessionId: 'selected',
        cwd: root,
        sessionAllowList: new Set([
          `configured-mcp:${JSON.stringify([configs.one.librarySourceId, 'search'])}`,
        ]),
      });
      const input = new AsyncQueue<{ message: { content: string } }>();
      const chat = await openResponsesChat({
        conversationId: 'selected',
        binding: {
          accountId: 'offline-fixture',
          accountLabel: 'Offline',
          provider,
          model: 'offline-no-model',
          profileRevision: 'fixture',
        },
        apiKey: 'never-used',
        session: registry.get(clientId)!,
        registry,
        input,
        eventStore: events,
        store: privateStore,
        systemPrompt: '',
        env: {
          MITZO_SESSION_ID: 'selected',
          MITZO_AGENT_NAME: 'Selected',
          MITZO_REPO_PRIMARY: root,
        },
        mcpServers: configs,
        resume,
        configuredSourceEnv: omitSourceEnv ? undefined : options.env,
        configuredTools: { catalog, ...options },
      });
      sessions.push(chat);
      return capture.options!;
    }
    try {
      const discovered = await catalog.refresh(options);
      const selected = discovered.find((row) => row.source === 'one' && row.name === 'search')!;
      const ref = catalog.reference(selected);
      const definition = {
        name: 'Source selected',
        role: 'agent',
        instructions: 'Help',
        expectedOutput: 'Result',
        acceptanceCriteria: ['Correct'],
        modelPolicyRole: 'agent',
        tools: [ref],
      };
      const draft = library.saveDraft('user', {
        profileId: 'selected',
        expectedVersion: 0,
        expectedRevision: 0,
        idempotencyKey: 'save',
        definition,
      });
      const published = library.publish('user', {
        profileId: draft.profileId,
        expectedVersion: draft.version,
        idempotencyKey: 'publish',
      });
      expect(published.contentHash).toBe(
        createHash('sha256').update(JSON.stringify(published.definition)).digest('hex'),
      );
      events.upsertSession({ sessionId: 'selected', agentProfile: published });
      const discoveries = options.connect.mock.calls.length;
      await expect(open(false, true)).rejects.toThrow(
        'Configured source launch environment is unavailable',
      );
      expect(options.connect).toHaveBeenCalledTimes(discoveries);
      let runtime = await open(false);
      expect(runtime.tools).toHaveLength(2);
      expect(runtime.tools.some((tool: { name: string }) => tool.name === 'AskUserQuestion')).toBe(
        true,
      );
      const wire = runtime.tools.find(
        (tool: { name: string }) => tool.name !== 'AskUserQuestion',
      )!.name;
      expect(
        await runtime.executeTool({ id: 'allowed', name: wire, input: {} }, options.signal),
      ).toMatchObject({ content: 'correct peer' });
      expect(peers['fake-one']).toHaveBeenCalledOnce();
      const otherAlias = `mitzo_mcp_${createHash('sha256')
        .update(JSON.stringify([configs.two.librarySourceId, 'search']))
        .digest('hex')
        .slice(0, 32)}`;
      const unselectedAlias = `mitzo_mcp_${createHash('sha256')
        .update(JSON.stringify([configs.one.librarySourceId, 'unselected']))
        .digest('hex')
        .slice(0, 32)}`;
      for (const name of [
        'search',
        'mcp__two__search',
        'mcp__one__unselected',
        otherAlias,
        unselectedAlias,
        'mcp__11111111-1111-4111-8111-111111111111__search',
        'ConnectionRequest',
        'mcp__mitzo-connections__ConnectionRequest',
        'RequestGithubPublish',
        'Bash',
      ]) {
        expect(
          await runtime.executeTool(
            { id: name, name, input: { tool: wire, name: 'search' } },
            options.signal,
          ),
        ).toMatchObject({ is_error: true });
      }
      expect(peers['fake-two']).not.toHaveBeenCalled();
      names.push('added');
      await catalog.refresh(options);
      expect(catalog.list().some((row) => row.name === 'added')).toBe(true);
      expect(runtime.tools).toHaveLength(2);
      const mutableSources = configs as Record<string, typeof configs.one>;
      mutableSources.renamed = configs.one;
      delete mutableSources.one;
      await catalog.refresh(options);
      expect(catalog.list().find((tool) => tool.id === ref.id)?.version).toBe(ref.version);
      const later = library.saveDraft('user', {
        profileId: draft.profileId,
        expectedVersion: 0,
        expectedRevision: published.revision,
        idempotencyKey: 'later-save',
        definition: { ...definition, tools: [] },
      });
      library.publish('user', {
        profileId: draft.profileId,
        expectedVersion: later.version,
        idempotencyKey: 'later-publish',
      });
      const foreignCatalog = new ConfiguredToolCatalog(':memory:');
      try {
        const imported = library.importDraft('user', {
          profileId: 'imported',
          artifact: published,
          idempotencyKey: 'import',
        });
        expect(imported.definition.tools).toEqual([ref]);
        expect(() => foreignCatalog.resolve(imported.definition.tools![0], options)).toThrow(
          /unresolved/,
        );
        await foreignCatalog.refresh(options);
        expect(() => foreignCatalog.resolve(imported.definition.tools![0], options)).toThrow(
          /unresolved/,
        );
      } finally {
        foreignCatalog.close();
      }
      sessions.splice(0).forEach((chat) => chat.close());
      library.close();
      events.close();
      privateStore.close();
      catalog.close();
      library = new AgentLibraryStore(files('library'));
      events = new EventStore(files('events'));
      privateStore = new NativeResponsesStore(files('private'));
      catalog = new ConfiguredToolCatalog(files('catalog'));
      runtime = await open(true);
      expect(runtime.tools.map((tool: { name: string }) => tool.name)).toEqual([
        'AskUserQuestion',
        wire,
      ]);
      expect(events.getSession('selected')!.agentProfile).toEqual(published);
      revoked = true;
      expect(
        await runtime.executeTool({ id: 'revoked', name: wire, input: {} }, options.signal),
      ).toMatchObject({ is_error: true, content: 'Source authority revoked' });
      expect(peers['fake-one']).toHaveBeenCalledOnce();
      revoked = false;
      schema = { type: 'object', properties: { changed: { type: 'string' } } };
      await catalog.refresh(options);
      await expect(open(true)).rejects.toThrow(/changed|unavailable/);
      expect(
        await runtime.executeTool({ id: 'changed', name: wire, input: {} }, options.signal),
      ).toMatchObject({ is_error: true });
      names.splice(0, names.length, 'unselected');
      await catalog.refresh(options);
      await expect(open(true)).rejects.toThrow(/changed|unavailable/);
      expect(peers['fake-one']).toHaveBeenCalledOnce();
      expect(events.getSession('selected')!.agentProfile).toEqual(published);
      expect(peers['fake-two']).not.toHaveBeenCalled();
    } finally {
      sessions.forEach((chat) => chat.close());
      aborts.forEach((abort) => abort.abort());
      registry.dispose();
      library.close();
      events.close();
      privateStore.close();
      catalog.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
