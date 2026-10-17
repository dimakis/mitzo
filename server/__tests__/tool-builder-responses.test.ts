import { afterEach, expect, it, vi } from 'vitest';
import type { ToolDefinition, ToolUseBlock, ToolResultBlock } from '@mitzo/harness';
import { SessionRegistry } from '@mitzo/harness';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { bindAgentLibraryTransport } from '../agent-library-transport.js';
import { revokeAuthSession } from '../auth.js';
import { toolBuilderToolDefinitions } from '../tool-builder-tool-definitions.js';
import { CustomToolDraftInputSchema, type ToolBuilderExecutor } from '../tool-builder.js';
import { AsyncQueue } from '../async-queue.js';
import { AgentLibraryStore } from '../agent-library-store.js';
import { NativeResponsesStore } from '../native-responses-store.js';
import { EventStore } from '../event-store.js';
import {
  toolBuilderFixture as fixture,
  toolBuilderFixtureId as id,
} from './fixtures/tool-builder.js';

type Captured = {
  tools: ToolDefinition[];
  executeTool(block: ToolUseBlock, signal: AbortSignal): Promise<ToolResultBlock>;
};
const captured = vi.hoisted(() => ({
  options: [] as Captured[],
  approve: vi.fn(async (_name: string, input: Record<string, unknown>) => ({
    behavior: 'allow' as const,
    updatedInput: input,
  })),
}));
vi.mock('@mitzo/harness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mitzo/harness')>()),
  buildPermissionHandler: () => captured.approve,
}));
vi.mock('../native-responses-runner.js', () => ({
  NativeResponsesRunner: class {
    constructor(options: Captured) {
      captured.options.push(options);
    }
    async *run() {
      yield { type: 'result', session_id: 'custom-chat' };
    }
    interrupt() {}
    waitUntilIdle = async () => {};
  },
}));
vi.mock('../codex-mcp-tools.js', () => ({
  connectCodexMcpTools: vi.fn(async () => ({
    definitions: [],
    close: async () => {},
    displayName: (name: string) => name,
  })),
}));
import { openResponsesChat } from '../responses-chat-session.js';
const roots: string[] = [];
afterEach(async () => {
  captured.options.length = 0;
  captured.approve.mockClear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.each(['openai', 'google-vertex'] as const)(
  'runs the explicitly selected builder through actual %s chat without granting publication',
  async (provider) => {
    const f = fixture();
    const root = await mkdtemp(join(tmpdir(), 'mitzo-builder-chat-'));
    roots.push(root);
    const registry = new SessionRegistry();
    const library = new AgentLibraryStore(join(root, 'events.db'));
    const native = new NativeResponsesStore(join(root, 'native.db'));
    const unbind = bindAgentLibraryTransport('client', {
      id: randomUUID(),
      expiresAt: Date.now() + 60000,
    });
    try {
      const draft = library.saveDraft('user', {
        profileId: 'builder',
        expectedVersion: 0,
        expectedRevision: 0,
        idempotencyKey: 'draft',
        definition: {
          name: 'Builder',
          role: 'agent',
          instructions: 'Prepare a reviewed draft',
          expectedOutput: 'Draft',
          acceptanceCriteria: ['Tested'],
          modelPolicyRole: 'agent',
          tools: toolBuilderToolDefinitions.map((tool) => ({
            id: `mitzo:${tool.name}`,
            version: 1,
          })),
        },
      });
      const published = library.publish('user', {
        profileId: 'builder',
        expectedVersion: draft.version,
        idempotencyKey: 'publish',
      });
      registry.register('client', {
        transport: { send() {}, isOpen: () => true },
        abortController: new AbortController(),
        sessionId: 'builder-chat',
        cwd: root,
        mode: 'agent',
        sessionAllowList: new Set(),
      });
      const session = registry.get('client')!;
      session.worktreePaths.set('primary', { path: root, wtId: 'test' });
      const input = new AsyncQueue<{ message: { content: string } }>();
      input.close();
      const custom = CustomToolDraftInputSchema.strip().parse(f.draft);
      const run = vi.fn<ToolBuilderExecutor['run']>(async () => ({
        passed: true,
        complete: true,
        evidenceKind: 'trusted-executor',
        summary: 'Offline fixture passed',
        examples: custom.examples.map((example) => ({ passed: true, actual: example.expected })),
      }));
      const chat = await openResponsesChat({
        conversationId: 'builder-chat',
        binding: {
          accountId: 'fake',
          accountLabel: 'Fake',
          provider,
          model: 'offline-fixture',
          profileRevision: 'fake',
        },
        session,
        registry,
        input,
        systemPrompt: '',
        env: {},
        mcpServers: {},
        store: native,
        agentProfile: published,
        toolBuilder: {
          store: f.store,
          catalog: { search: async () => [], readContract: async () => ({}) },
          executor: { run },
          privateRoots: () => [],
        },
        ...(provider === 'google-vertex'
          ? {
              gemini: {
                accountId: 'fake',
                projectId: 'fake',
                region: 'global',
                getAccessToken: async () => {
                  throw Error('No live calls');
                },
              },
            }
          : { apiKey: 'fake-not-used' }),
      });
      try {
        const runner = captured.options.at(-1)!;
        expect(runner.tools.map((tool) => tool.name).sort()).toEqual(
          ['AskUserQuestion', ...toolBuilderToolDefinitions.map((tool) => tool.name)].sort(),
        );
        const response = await runner.executeTool(
          {
            type: 'tool_use',
            id: 'prepare',
            name: 'ToolBuilderPrepareDraft',
            input: { request: 'Count characters', custom },
          },
          session.abortController.signal,
        );
        expect(response.is_error).toBe(false);
        const prepared = JSON.parse(String(response.content));
        expect(prepared).toMatchObject({
          kind: 'draft',
          draft: { status: 'unpublished', version: 1 },
        });
        expect(run).toHaveBeenCalledOnce();
        expect(f.store.listTools('user')).toEqual([]);
        expect(
          (
            await runner.executeTool(
              {
                type: 'tool_use',
                id: 'submit',
                name: 'ToolBuilderSubmitReview',
                input: {
                  id: prepared.draft.id,
                  version: 1,
                  contractDigest: prepared.draft.contractDigest,
                },
              },
              session.abortController.signal,
            )
          ).is_error,
        ).toBe(false);
        expect(f.store.read('user', prepared.draft.id)?.status).toBe('submitted');
        for (const name of [
          'ToolBuilderPublish',
          'ToolBuilderReview',
          'Bash',
          'mitzo:ToolBuilderPrepareDraft',
        ])
          expect(
            (
              await runner.executeTool(
                { type: 'tool_use', id: name, name, input: {} },
                session.abortController.signal,
              )
            ).is_error,
          ).toBe(true);
      } finally {
        chat.close();
        session.abortController.abort();
      }
    } finally {
      unbind();
      registry.dispose();
      native.close();
      library.close();
      f.store.close();
    }
  },
);

it.each(['openai', 'google-vertex'] as const)(
  'admits published custom tools through actual %s exposure, dispatch and cold resume',
  async (provider) => {
    const f = fixture();
    const root = await mkdtemp(join(tmpdir(), 'mitzo-builder-provider-'));
    roots.push(root);
    const registry = new SessionRegistry();
    const library = new AgentLibraryStore(join(root, 'events.db'));
    const events = new EventStore(join(root, 'events.db'));
    let native = new NativeResponsesStore(join(root, 'native.db'));
    const auth = { id: randomUUID(), expiresAt: Date.now() + 60000 };
    let unbind = bindAgentLibraryTransport('client', auth);
    try {
      f.store.save('user', 'builder', 'call', f.draft, 0);
      f.store.submit('user', 'builder', id, 1, f.draft.contractDigest);
      f.store.review(
        'user',
        id,
        1,
        { decision: 'accepted', feedback: '', contractDigest: f.draft.contractDigest },
        'operator',
      );
      const publication = await f.store.publish('user', id, 1, f.draft.contractDigest);
      f.execute.mockClear();
      const draft = library.saveDraft('user', {
        profileId: 'custom',
        expectedVersion: 0,
        expectedRevision: 0,
        idempotencyKey: 'draft',
        definition: {
          name: 'Length',
          role: 'agent',
          instructions: 'Count text',
          expectedOutput: 'Length',
          acceptanceCriteria: ['Exact count'],
          modelPolicyRole: 'agent',
          tools: [publication.reference],
        },
      });
      const published = library.publish('user', {
        profileId: 'custom',
        expectedVersion: draft.version,
        idempotencyKey: 'publish',
      });
      events.upsertSession({ sessionId: 'custom-chat', agentProfile: published });
      const makeOptions = (resume: boolean) => {
        registry.register('client', {
          transport: { send() {}, isOpen: () => true },
          abortController: new AbortController(),
          sessionId: 'custom-chat',
          cwd: root,
          mode: 'agent',
          sessionAllowList: new Set(),
        });
        const input = new AsyncQueue<{ message: { content: string } }>();
        input.close();
        return {
          conversationId: 'custom-chat',
          binding: {
            accountId: 'fake',
            accountLabel: 'Fake',
            provider,
            model: 'offline-fixture',
            profileRevision: 'fake',
          },
          session: registry.get('client')!,
          registry,
          input,
          systemPrompt: '',
          env: {},
          mcpServers: {},
          eventStore: events,
          store: native,
          resume,
          toolBuilder: { store: f.store },
          ...(provider === 'google-vertex'
            ? {
                gemini: {
                  accountId: 'fake',
                  projectId: 'fake',
                  region: 'global',
                  getAccessToken: async () => {
                    throw Error('No live calls');
                  },
                },
              }
            : { apiKey: 'fake-not-used' }),
        };
      };
      for (const resume of [false, true]) {
        const options = makeOptions(resume);
        const chat = await openResponsesChat(options);
        try {
          const runner = captured.options.at(-1)!;
          const wire = publication.binding.definition.name;
          expect(runner.tools.map((tool) => tool.name).sort()).toEqual(
            ['AskUserQuestion', wire].sort(),
          );
          for (const name of [
            publication.reference.id,
            'mcp__mitzo-connections__' + wire,
            'Bash',
            'ConnectionRequest',
            'ToolBuilderPrepareDraft',
          ]) {
            expect(
              (
                await runner.executeTool(
                  { type: 'tool_use', id: 'deny', name, input: {} },
                  options.session.abortController.signal,
                )
              ).is_error,
            ).toBe(true);
          }
          f.execute.mockClear();
          if (!resume) {
            captured.approve.mockImplementationOnce(async (_name, input) => {
              revokeAuthSession(auth);
              return { behavior: 'allow', updatedInput: input };
            });
            expect(
              (
                await runner.executeTool(
                  { type: 'tool_use', id: 'revoked', name: wire, input: { text: 'abc' } },
                  options.session.abortController.signal,
                )
              ).is_error,
            ).toBe(true);
            expect(f.execute).not.toHaveBeenCalled();
            unbind();
            unbind = bindAgentLibraryTransport('client', {
              id: randomUUID(),
              expiresAt: Date.now() + 60000,
            });
          }
          expect(
            await runner.executeTool(
              { type: 'tool_use', id: 'invoke', name: wire, input: { text: 'abcd' } },
              options.session.abortController.signal,
            ),
          ).toMatchObject({ is_error: false, content: '{"length":4}' });
          expect(f.execute).toHaveBeenCalledOnce();
          if (resume) {
            f.drift();
            expect(
              (
                await runner.executeTool(
                  { type: 'tool_use', id: 'drift', name: wire, input: { text: 'abc' } },
                  options.session.abortController.signal,
                )
              ).is_error,
            ).toBe(true);
            expect(f.execute).toHaveBeenCalledOnce();
          }
        } finally {
          chat.close();
          options.session.abortController.abort();
        }
        if (!resume) {
          const changed = library.saveDraft('user', {
            profileId: 'custom',
            expectedVersion: 0,
            expectedRevision: 1,
            idempotencyKey: 'changed',
            definition: { ...published.definition, tools: [] },
          });
          library.publish('user', {
            profileId: 'custom',
            expectedVersion: changed.version,
            idempotencyKey: 'changed-publish',
          });
          native.close();
          native = new NativeResponsesStore(join(root, 'native.db'));
        }
      }
      await expect(openResponsesChat(makeOptions(true))).rejects.toThrow('changed');
    } finally {
      registry.dispose();
      unbind();
      native.close();
      events.close();
      library.close();
      f.store.close();
    }
  },
);
