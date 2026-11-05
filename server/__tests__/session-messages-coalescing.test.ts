import { expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createSessionMessagesHandler } from '../session-messages-route.js';

it('shares overlapping reads, separates cursor boundaries, and does not retain completed history', async () => {
  let complete!: (value: unknown) => void;
  const getMessages = vi.fn(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const getReconnectTranscript = vi.fn(() => ['bounded']);
  const handler = createSessionMessagesHandler({
    getMessages,
    getReconnectTranscript,
    getSessionTranscript: async () => [],
  });
  const invoke = async (query = {}) => {
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    await handler(
      { params: { id: 's' }, query } as unknown as Request,
      res as unknown as Response,
      vi.fn(),
    );
    return res;
  };
  const first = invoke(),
    second = invoke();
  await Promise.resolve();
  expect(getMessages).toHaveBeenCalledTimes(1);
  expect((await invoke({ throughSeq: '10' })).json).toHaveBeenCalledWith(['bounded']);
  complete(['saved']);
  expect((await first).json).toHaveBeenCalledWith(['saved']);
  expect((await second).json).toHaveBeenCalledWith(['saved']);
  const third = invoke();
  await Promise.resolve();
  expect(getMessages).toHaveBeenCalledTimes(2);
  complete(['new']);
  expect((await third).json).toHaveBeenCalledWith(['new']);
});

it('contains a failed shared read and permits a fresh retry', async () => {
  const read = vi.fn().mockRejectedValueOnce(Error('private source')).mockResolvedValueOnce([]);
  const handler = createSessionMessagesHandler({
    getMessages: read,
    getReconnectTranscript: () => [],
    getSessionTranscript: read,
  });
  const invoke = async () => {
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
    await handler(
      { params: { id: 's' }, query: {} } as unknown as Request,
      res as unknown as Response,
      vi.fn(),
    );
    return res;
  };
  expect((await invoke()).status).toHaveBeenCalledWith(500);
  expect((await invoke()).json).toHaveBeenCalledWith([]);
  expect(read).toHaveBeenCalledTimes(2);
});

it('does not merge a newer event revision into an older pending transcript', async () => {
  let revision = 1;
  const reads: Array<(value: unknown) => void> = [];
  const getMessages = vi.fn(
    () =>
      new Promise((resolve) => {
        reads.push(resolve);
      }),
  );
  const handler = createSessionMessagesHandler({
    getMessages,
    getSessionTranscript: getMessages,
    getReconnectTranscript: () => [],
    getRevision: () => revision,
  });
  const invoke = () =>
    handler(
      { params: { id: 's' }, query: {} } as unknown as Request,
      { json: vi.fn() } as unknown as Response,
      vi.fn(),
    );
  const first = invoke();
  revision++;
  const second = invoke();
  await Promise.resolve();
  expect(getMessages).toHaveBeenCalledTimes(2);
  reads.forEach((resolve) => resolve([]));
  await Promise.all([first, second]);
});
