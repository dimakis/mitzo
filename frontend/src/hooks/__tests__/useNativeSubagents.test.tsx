// @vitest-environment node-compatible-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import type { NativeSubagentSnapshot } from '@mitzo/protocol';
import { NativeSubagents } from '../../components/NativeSubagents';
import { AUTH_LOST_EVENT } from '../../lib/api-fetch';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(['disconnect', 'invalid frame'])(
  'retains the inspected child and drafts across reset then %s, restoring only fresh authority',
  async (failure) => {
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const fetch = vi.fn(
      async (_input: unknown, init?: RequestInit) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streams.push(controller);
              init?.signal?.addEventListener(
                'abort',
                () => {
                  try {
                    controller.close();
                  } catch {
                    /* The test or decoder already closed this stream. */
                  }
                },
                { once: true },
              );
            },
          }),
        ),
    );
    vi.stubGlobal('fetch', fetch);
    window.HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    });
    window.HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    });
    const child: NativeSubagentSnapshot = {
      threadId: 'child',
      parentThreadId: 'parent',
      commandId: 'command',
      name: 'Reviewer',
      task: 'Review edge cases',
      model: 'fixture',
      state: 'working',
      available: true,
      revision: 1,
      blocks: [{ id: 'output', type: 'text', content: 'Saved public output' }],
    };
    const send = async (value: unknown) =>
      act(async () => {
        streams.at(-1)!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`));
      });
    const reconnect = async () => act(async () => window.dispatchEvent(new Event('online')));
    render(
      <MemoryRouter>
        <NativeSubagents sessionId={`reconnect-${failure}`} commandId="command" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(streams).toHaveLength(1));
    await send({ type: 'reset', available: true });
    await send({ type: 'agent', agent: child });
    fireEvent.click(screen.getByRole('button', { name: /1 subagent/ }));
    fireEvent.click(screen.getByRole('button', { name: /Reviewer.*Working/ }));
    const dialog = within(screen.getByRole('dialog', { name: 'Reviewer' }));
    const draft = dialog.getByRole('textbox', { name: 'Message Reviewer' });
    fireEvent.change(draft, { target: { value: 'Retain my child draft' } });
    await reconnect();
    await waitFor(() => expect(streams).toHaveLength(2));
    await send({ type: 'reset', available: true });
    if (failure === 'disconnect') await act(async () => streams.at(-1)!.close());
    else await send({ type: 'invalid' });
    await waitFor(() =>
      expect(screen.getByText(/Live subagent activity is unavailable/)).toBeTruthy(),
    );
    expect(screen.getByRole('dialog', { name: 'Reviewer' })).toBeTruthy();
    expect(dialog.getByText('Saved public output')).toBeTruthy();
    expect(draft).toHaveProperty('value', 'Retain my child draft');
    expect(dialog.getByRole('button', { name: 'Send to Reviewer' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(dialog.getByRole('button', { name: 'Stop Reviewer' })).toHaveProperty('disabled', true);
    await reconnect();
    await waitFor(() => expect(streams).toHaveLength(3));
    await send({ type: 'reset', available: true });
    expect(dialog.getByRole('button', { name: 'Send to Reviewer' })).toHaveProperty(
      'disabled',
      true,
    );
    await send({
      type: 'agent',
      agent: { ...child, available: false, state: 'completed', revision: 2 },
    });
    await send({ type: 'status', available: true });
    expect(dialog.getByRole('button', { name: 'Send to Reviewer' })).toHaveProperty(
      'disabled',
      true,
    );
    await send({ type: 'agent', agent: { ...child, state: 'completed', revision: 3 } });
    expect(dialog.getByRole('button', { name: 'Send to Reviewer' })).toHaveProperty(
      'disabled',
      false,
    );
    expect(dialog.getByText('Result returned')).toBeTruthy();
    expect(draft).toHaveProperty('value', 'Retain my child draft');
    expect(fetch).toHaveBeenCalledTimes(3);
    await act(async () => window.dispatchEvent(new Event(AUTH_LOST_EVENT)));
    expect(screen.queryByText('Saved public output')).toBeNull();
    expect(screen.getByText('Sign in again to inspect subagents.')).toBeTruthy();
  },
);
