// @vitest-environment node-compatible-dom
import Database from 'better-sqlite3';
import React from 'react';
import express from 'express';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CodexSubagents } from '../../server/codex-subagents.js';
import { CodexSubagentStore } from '../../server/codex-subagent-store.js';
import { codexNativeExecutionPolicy } from '../../server/codex-native-execution-policy.js';
import { ToolPill } from '../../frontend/src/components/ToolPill';
import { createCodexSubagentRouter } from '../../server/codex-subagent-routes.js';

vi.mock('../../server/logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(['thread/read', 'thread/resume', 'thread/turns/list'])(
  'shows an actual adapter failure from %s through the authenticated feed and transcript consumer',
  async (failedMethod) => {
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
    };
    const onChild = vi.fn();
    const execute = vi.fn();
    let broken = true;
    const owner = new CodexSubagents({
      scope: { conversationId: 'chat', bindingRevision: 'binding' },
      store: new CodexSubagentStore(db),
      root: () => ({
        threadId: 'root',
        commandId: 'command',
        model: 'fixture',
        modelProvider: 'openai',
        policy,
      }),
      assertCurrent: () => {},
      tools: [],
      executeTool: execute,
      onChild,
      request: async (method, params) => {
        if (broken && method === failedMethod) throw Error('secret native error');
        if (method === 'thread/read') return { thread: { ...thread, id: params.threadId } };
        if (method === 'thread/resume')
          return { thread, model: 'fixture', modelProvider: 'openai' };
        if (method === 'thread/turns/list') return { data: [{ id: 'turn', status: 'completed' }] };
        return { data: [] };
      },
    });
    const app = express();
    app.use(express.json());
    app.use(
      '/api/sessions',
      createCodexSubagentRouter({ authorize: () => {}, owner: () => owner, retained: () => [] }),
    );
    const fetch = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/inspect')) {
        const response = await request(app)
          .post(input)
          .send(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify(response.body), { status: response.status });
      }
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          const send = (value: unknown) =>
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
          send({ type: 'reset', available: true });
          for (const agent of owner.list()) send({ type: 'agent', agent });
        },
      });
      return new Response(body);
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
      expect(onChild).toHaveBeenCalledOnce();
      await owner.settled();
      const observed = onChild.mock.calls[0][0];
      render(
        <MemoryRouter>
          <ToolPill
            sessionId="chat"
            block={{
              blockId: 'children',
              blockType: 'tool_use',
              content: '',
              toolName: 'Agent',
              rawInput: { type: 'agent', nativeSubagentCommandId: observed.commandId },
              toolResult: 'Observed',
            }}
          />
        </MemoryRouter>,
      );
      fireEvent.click(await screen.findByRole('button', { name: /1 subagent/ }));
      fireEvent.click(
        await screen.findByRole('button', { name: /Subagent.*Inspection unavailable/ }),
      );
      const dialog = within(screen.getByRole('dialog', { name: 'Subagent' }));
      expect(dialog.getByText(/Subagent inspection failed/)).toBeTruthy();
      expect(dialog.getByRole('button', { name: 'Send to Subagent' })).toHaveProperty(
        'disabled',
        true,
      );
      expect(dialog.getByRole('button', { name: 'Stop Subagent' })).toHaveProperty(
        'disabled',
        true,
      );
      expect(dialog.getByRole('button', { name: 'Retry inspection' })).toBeTruthy();
      expect(document.body.textContent).not.toContain('secret native error');
      expect(fetch).toHaveBeenCalledTimes(1);
      broken = false;
      fireEvent.click(dialog.getByRole('button', { name: 'Retry inspection' }));
      await waitFor(() => expect(dialog.queryByText(/Subagent inspection failed/)).toBeNull());
      expect(dialog.getByText('Result returned')).toBeTruthy();
      fireEvent.change(dialog.getByRole('textbox', { name: 'Message Subagent' }), {
        target: { value: 'Keep my draft' },
      });
      expect(dialog.getByRole('button', { name: 'Send to Subagent' })).toHaveProperty(
        'disabled',
        false,
      );
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(onChild).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
    } finally {
      cleanup();
      owner.close();
      db.close();
    }
  },
);
