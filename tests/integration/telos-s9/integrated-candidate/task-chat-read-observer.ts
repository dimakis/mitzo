import type { Page, Request, Response } from '@playwright/test';
import { expect, vi } from 'vitest';

type Read = {
  path: string;
  requestOrdinal: number;
  status: number;
  body?: unknown;
  bodyReadError?: string;
};

/** Retain real browser reads without attributing old response completions to a new route. */
export function observeTaskChatReads(page: Page) {
  const reads: Read[] = [];
  const requests = new WeakMap<Request, number>();
  const pending = new Map<number, { path: string; requestOrdinal: number }>();
  let ordinal = 0;
  const onRequest = (request: Request) => requests.set(request, ++ordinal);
  const onResponse = (response: Response) => {
    const request = response.request();
    const requestOrdinal = requests.get(request);
    const path = new URL(response.url()).pathname;
    if (
      requestOrdinal === undefined ||
      request.method() !== 'GET' ||
      !(
        path === '/api/tasks' ||
        path.startsWith('/api/telos/work/') ||
        (path.startsWith('/api/sessions/') && path.endsWith('/meta'))
      )
    )
      return;
    pending.set(requestOrdinal, { path, requestOrdinal });
    void (async () => {
      const read = { path, requestOrdinal, status: response.status() };
      try {
        reads.push({ ...read, body: await response.json() });
      } catch (error) {
        reads.push({ ...read, bodyReadError: String(error) });
      } finally {
        pending.delete(requestOrdinal);
      }
    })();
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  const since = (boundary: number) => reads.filter((read) => read.requestOrdinal > boundary);
  return {
    reads,
    since,
    boundary: () => ordinal,
    pending: () => [...pending.values()],
    async waitForTask(
      taskId: string,
      boundary: number,
      options = { timeout: 10_000, interval: 100 },
    ) {
      // A discarded document's unrelated body may never settle. Only completed
      // reads from requests issued after this boundary can satisfy the consumer.
      return vi.waitFor(() => {
        const read = since(boundary).find(
          (read) =>
            read.path === '/api/tasks' &&
            read.status === 200 &&
            JSON.stringify(read.body)?.includes(taskId),
        );
        expect(read, 'new browser GET /api/tasks with the exact task').toBeDefined();
        return read!;
      }, options);
    },
    close() {
      page.off('request', onRequest);
      page.off('response', onResponse);
    },
  };
}
