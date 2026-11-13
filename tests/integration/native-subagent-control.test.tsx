// @vitest-environment node-compatible-dom
import Database from 'better-sqlite3';
import React from 'react';
import express from 'express';
import request from 'supertest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexSubagents } from '../../server/codex-subagents.js';
import { CodexSubagentStore } from '../../server/codex-subagent-store.js';
import { codexNativeExecutionPolicy } from '../../server/codex-native-execution-policy.js';
import { CodexRequestError } from '../../server/codex-app-server-client.js';
import { createCodexSubagentRouter } from '../../server/codex-subagent-routes.js';
import { NativeSubagents } from '../../frontend/src/components/NativeSubagents';

vi.mock('../../server/logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('keeps the rejected message and its adapter diagnostic visible through the authenticated route and feed', async () => {
  const db = new Database(':memory:');
  const policy = codexNativeExecutionPolicy({
    bindingRevision: 'binding',
    mode: 'agent',
    cwd: '/workspace',
    readableRoots: ['/workspace'],
    writableRoots: ['/workspace'],
    deniedRoots: ['/private/auth'],
  });
  const thread = {
    id: 'child',
    parentThreadId: 'root',
    sessionId: 'tree',
    cwd: '/workspace',
    model: 'fixture',
    modelProvider: 'openai',
    agentNickname: 'Peirce',
  };
  let nativeSends = 0;
  const owner = new CodexSubagents({
    scope: { conversationId: 'control-chat', bindingRevision: 'binding' },
    store: new CodexSubagentStore(db),
    root: () => ({
      threadId: 'root',
      commandId: 'command',
      model: 'fixture',
      modelProvider: 'openai',
      policy,
    }),
    assertCurrent() {},
    tools: [],
    executeTool: vi.fn(),
    onChild() {},
    request: async (method, params, fence) => {
      fence?.();
      if (method === 'thread/read') return { thread: { ...thread, id: params.threadId } };
      if (method === 'thread/resume') return { thread, model: 'fixture', modelProvider: 'openai' };
      if (method === 'thread/turns/list') return { data: [] };
      if (method === 'turn/steer') {
        nativeSends++;
        throw new CodexRequestError(method, 'invalid_request', -32602);
      }
      return {};
    },
  });
  const app = express();
  app.use(express.json());
  app.use(
    '/api/sessions',
    createCodexSubagentRouter({ authorize() {}, owner: () => owner, retained: () => [] }),
  );
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith('/control')) {
      const result = await request(app)
        .post(input)
        .send(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(result.body), { status: result.status });
    }
    let unsubscribe = () => {};
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(controller) {
          const send = (value: unknown) =>
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
          send({ type: 'reset', available: true });
          owner.list().forEach((agent) => send({ type: 'agent', agent }));
          unsubscribe = owner.subscribe((agent) => send({ type: 'agent', agent }));
          init?.signal?.addEventListener(
            'abort',
            () => {
              unsubscribe();
              controller.close();
            },
            { once: true },
          );
        },
        cancel() {
          unsubscribe();
        },
      }),
    );
  });
  vi.stubGlobal('fetch', fetch);
  window.HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  window.HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  });
  try {
    owner.notification('thread/started', { thread });
    owner.notification('turn/started', { threadId: 'child', turn: { id: 'turn' } });
    await owner.settled();
    render(
      <MemoryRouter>
        <NativeSubagents sessionId="control-chat" commandId="command" />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /1 subagent/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Peirce.*Working/ }));
    const dialog = within(screen.getByRole('dialog', { name: 'Peirce' }));
    const draft = dialog.getByRole('textbox', { name: 'Message Peirce' });
    fireEvent.change(draft, { target: { value: 'yo peirce' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Send to Peirce' }));
    await waitFor(() => expect(dialog.getByText(/This request was not accepted/)).toBeTruthy());
    expect(draft).toHaveProperty('value', 'yo peirce');
    expect(dialog.getByText('Control details')).toBeTruthy();
    expect(dialog.getByText(owner.list()[0].controlFailure!.reference)).toBeTruthy();
    expect(nativeSends).toBe(1);
    expect(dialog.getByRole('button', { name: 'Refresh activity' })).toBeTruthy();
  } finally {
    cleanup();
    owner.close();
    db.close();
  }
});
