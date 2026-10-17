import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  toolBuilderFixture as fixture,
  toolBuilderFixtureId as id,
} from './fixtures/tool-builder.js';
import { admitCustomTools } from '../custom-tool-admission.js';
import {
  bindAgentToolSelection,
  bindConfiguredAgentTools,
  agentToolAllowed,
} from '../agent-tool-selection.js';
import { NativeResponsesStore } from '../native-responses-store.js';
import { ToolBuilderStore } from '../tool-builder-store.js';
import { AgentLibraryStore } from '../agent-library-store.js';
import { createAgentLibraryRouter } from '../agent-library-router.js';
import express from 'express';
import request from 'supertest';
import type { AgentToolReference, SymposiumProfileDefinition } from '@mitzo/protocol';

const profile = (reference: AgentToolReference): SymposiumProfileDefinition => ({
  name: 'Length agent',
  role: 'agent',
  instructions: 'Count characters',
  expectedOutput: 'Length',
  acceptanceCriteria: ['Return the exact character count'],
  modelPolicyRole: 'agent',
  tools: [reference],
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function published() {
  const f = fixture();
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
  return { ...f, publication };
}

it('requires separate assignment and enforces exact exposure, schema, approval and dispatch', async () => {
  const f = await published();
  const session = {};
  let current = true;
  const approve = vi.fn(async (_name: string, input: Record<string, unknown>) => ({
    behavior: 'allow' as const,
    updatedInput: input,
  }));
  try {
    bindAgentToolSelection(session, profile(f.publication.reference));
    const admitted = admitCustomTools({
      store: f.store,
      refs: [f.publication.reference],
      approve,
      stillAllowed: (name) => agentToolAllowed(session, name),
      assertCurrent() {
        if (!current) throw Error('revoked');
      },
    });
    expect(admitted.definitions).toEqual([f.publication.binding.definition]);
    expect(f.execute).not.toHaveBeenCalled();
    bindConfiguredAgentTools(session, admitted.admitted);
    const name = admitted.definitions[0].name;
    expect(agentToolAllowed(session, name)).toBe(true);
    expect(agentToolAllowed(session, 'mcp__mitzo-connections__' + name)).toBe(false);
    expect(
      await admitted.execute('alias', { text: 'abc' }, new AbortController().signal, {
        callId: 'a',
      }),
    ).toBeUndefined();
    expect(
      (
        await admitted.execute(name, { text: 42 }, new AbortController().signal, {
          callId: 'invalid',
        })
      )?.isError,
    ).toBe(true);
    expect(approve).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(
      await admitted.execute(name, { text: 'abcd' }, new AbortController().signal, {
        callId: 'call',
      }),
    ).toEqual({ content: '{"length":4}', isError: false });
    expect(f.execute).toHaveBeenCalledOnce();
    current = false;
    expect(
      (
        await admitted.execute(name, { text: 'abc' }, new AbortController().signal, {
          callId: 'revoked',
        })
      )?.isError,
    ).toBe(true);
    expect(f.execute).toHaveBeenCalledOnce();
  } finally {
    f.store.close();
  }
});

it('does not execute after denied approval, input substitution, revocation, cancellation or source drift during approval', async () => {
  for (const action of ['deny', 'substitute', 'revoke', 'cancel', 'drift'] as const) {
    const f = await published();
    let allowed = true;
    const controller = new AbortController();
    try {
      const admitted = admitCustomTools({
        store: f.store,
        refs: [f.publication.reference],
        stillAllowed: () => allowed,
        assertCurrent() {},
        approve: async (_name, input) => {
          if (action === 'revoke') allowed = false;
          if (action === 'cancel') controller.abort();
          if (action === 'drift') f.drift();
          if (action === 'deny') return { behavior: 'deny', message: 'Denied' };
          return {
            behavior: 'allow',
            updatedInput: action === 'substitute' ? { text: 'changed' } : input,
          };
        },
      });
      expect(
        (
          await admitted.execute(admitted.definitions[0].name, { text: 'abc' }, controller.signal, {
            callId: 'test',
          })
        )?.isError,
      ).toBe(true);
      expect(f.execute).not.toHaveBeenCalled();
    } finally {
      f.store.close();
    }
  }
});

it('executes the captured approved input when the caller mutates its object during approval', async () => {
  const f = await published();
  const input = { text: 'abc' };
  try {
    const admitted = admitCustomTools({
      store: f.store,
      refs: [f.publication.reference],
      stillAllowed: () => true,
      assertCurrent() {},
      approve: async (_name, approved) => {
        input.text = 'unapproved replacement';
        return { behavior: 'allow', updatedInput: approved };
      },
    });
    const result = await admitted.execute(
      admitted.definitions[0].name,
      input,
      new AbortController().signal,
      { callId: 'mutable' },
    );
    expect(result).toEqual({ content: '{"length":3}', isError: false });
    expect(f.execute.mock.calls[0][0]).toEqual({ text: 'abc' });
  } finally {
    f.store.close();
  }
});

it('projects only published custom versions through the real catalog and keeps exports opaque', async () => {
  const f = await published();
  const library = new AgentLibraryStore(':memory:');
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.authSession = { id: 'operator', expiresAt: Date.now() + 60000 };
    next();
  });
  app.use('/library', createAgentLibraryRouter(library, { toolBuilder: () => f.store }));
  try {
    const tools = await request(app).get('/library/tools').expect(200);
    expect(tools.body.tools).toContainEqual(f.publication.entry);
    const definition = profile(f.publication.reference);
    const draft = library.saveDraft('user', {
      profileId: 'length-agent',
      expectedVersion: 0,
      expectedRevision: 0,
      idempotencyKey: 'save',
      definition,
    });
    const version = library.publish('user', {
      profileId: 'length-agent',
      expectedVersion: draft.version,
      idempotencyKey: 'publish',
    });
    expect(JSON.stringify(version.definition.tools)).toBe(
      JSON.stringify([f.publication.reference]),
    );
    expect(JSON.stringify(version.definition.tools)).not.toContain('source');
    const imported = library.importDraft('user', {
      profileId: 'imported-length-agent',
      artifact: version,
      idempotencyKey: 'import',
    });
    expect(imported.definition.tools).toEqual([f.publication.reference]);
    f.drift();
    const stale = await request(app).get('/library/tools').expect(200);
    expect(
      stale.body.tools.find((tool: { id: string }) => tool.id === f.publication.entry.id).routes,
    ).toEqual([]);
  } finally {
    f.store.close();
    library.close();
  }
});

it('retains exact admitted definitions and mappings on cold resume and refuses replacement source', async () => {
  const f = await published();
  const root = await mkdtemp(join(tmpdir(), 'custom-resume-'));
  roots.push(root);
  const path = join(root, 'responses.db');
  const binding = {
    accountId: 'fake',
    accountLabel: 'Fake',
    provider: 'openai' as const,
    model: 'offline',
    profileRevision: 'fake',
  };
  const snapshot = {
    profileHash: createHash('sha256').update('profile').digest('hex'),
    tools: [f.publication.binding.definition],
    customTools: [
      { wireName: f.publication.binding.definition.name, reference: f.publication.reference },
    ],
  };
  let store = new NativeResponsesStore(path);
  try {
    store.bindAgentTools('chat', binding, snapshot, false);
    store.close();
    store = new NativeResponsesStore(path);
    store.bindAgentTools('chat', binding, snapshot, true);
    expect(() =>
      store.bindAgentTools(
        'chat',
        binding,
        { ...snapshot, tools: [{ ...snapshot.tools[0], description: 'changed' }] },
        true,
      ),
    ).toThrow('changed');
    f.drift();
    expect(() =>
      admitCustomTools({
        store: f.store,
        refs: [f.publication.reference],
        approve: vi.fn(),
        stillAllowed: () => true,
        assertCurrent() {},
      }),
    ).toThrow();
    const foreign = new ToolBuilderStore(':memory:', f.registry);
    try {
      expect(() => foreign.resolve('user', f.publication.reference)).toThrow();
    } finally {
      foreign.close();
    }
  } finally {
    store.close();
    f.store.close();
  }
});
