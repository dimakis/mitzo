import { z } from 'zod';
import { TelosWorkItemSchema } from '@mitzo/protocol';
import type { Page, Request, Response } from '@playwright/test';
import { expect, vi } from 'vitest';

type Read = {
  path: string;
  requestOrdinal: number;
  status: number;
  body?: unknown;
  bodyReadError?: string;
};

const collectionSchema = z.object({
  profiles: z.array(z.string()),
  records: z.array(TelosWorkItemSchema).max(5000),
  failures: z.array(z.object({ itemId: z.string(), code: z.string() })),
});

type TaskRead = { id: string; status: string; children: TaskRead[] };
const taskStatuses = new Set([
  'pending',
  'active',
  'done',
  'pending_review',
  'blocked',
  'skipped',
  'failed',
]);

// GET /api/tasks returns a tree envelope. Validate its consumer fields before
// matching identity; text in a description or a malformed body cannot release it.
function isTaskRead(value: unknown): value is TaskRead {
  if (value === null || typeof value !== 'object') return false;
  const task = value as Partial<TaskRead>;
  return (
    typeof task.id === 'string' &&
    task.id.length > 0 &&
    typeof task.status === 'string' &&
    taskStatuses.has(task.status) &&
    Array.isArray(task.children) &&
    task.children.every(isTaskRead)
  );
}

function containsTask(body: unknown, taskId: string): boolean {
  if (body === null || typeof body !== 'object' || !('tasks' in body)) return false;
  const tasks = body.tasks;
  if (!Array.isArray(tasks) || !tasks.every(isTaskRead)) return false;
  const matches = (task: TaskRead): boolean => task.id === taskId || task.children.some(matches);
  return tasks.some(matches);
}

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
    async waitForCollectionRecords(
      itemIds: string[],
      boundary: number,
      options = { timeout: 10_000, interval: 100 },
    ) {
      return vi.waitFor(() => {
        const read = since(boundary)
          .flatMap((read) => {
            if (read.path !== '/api/telos/work/collection' || read.status !== 200) return [];
            const parsed = collectionSchema.safeParse(read.body);
            if (
              !parsed.success ||
              !itemIds.every((id) => parsed.data.records.some((record) => record.itemId === id))
            )
              return [];
            return [{ ...read, body: parsed.data }];
          })
          .at(-1);
        expect(
          read,
          'fresh completed canonical collection with every attached identity: ' +
            JSON.stringify({
              boundary,
              observed: since(boundary)
                .filter((value) => value.path === '/api/telos/work/collection')
                .slice(-10)
                .map((value) => {
                  const parsed = collectionSchema.safeParse(value.body);
                  return {
                    ordinal: value.requestOrdinal,
                    status: value.status,
                    ids: parsed.success
                      ? parsed.data.records.slice(0, 20).map((record) => record.itemId)
                      : undefined,
                    invalid: !parsed.success,
                  };
                }),
              pending: [...pending.values()].slice(-10),
            }),
        ).toBeDefined();
        return read!;
      }, options);
    },
    async waitForSessionMeta(
      sessionId: string,
      boundary: number,
      options = { timeout: 10_000, interval: 100 },
    ) {
      return vi.waitFor(() => {
        const read = since(boundary).find(
          (read) =>
            read.path === `/api/sessions/${encodeURIComponent(sessionId)}/meta` &&
            read.status === 200 &&
            read.body !== null &&
            typeof read.body === 'object' &&
            'sessionId' in read.body &&
            read.body.sessionId === sessionId,
        );
        expect(read, 'new browser GET for the exact destination conversation').toBeDefined();
        return read!;
      }, options);
    },
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
            read.path === '/api/tasks' && read.status === 200 && containsTask(read.body, taskId),
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

/** A new document can mount an empty disabled composer before its own metadata
 * arrives. Observe only this navigation's real read before asserting its draft.
 */
export async function navigateToChatMetadata(page: Page, destination: string, sessionId: string) {
  const observer = observeTaskChatReads(page);
  const boundary = observer.boundary();
  try {
    await page.goto(destination);
    await observer.waitForSessionMeta(sessionId, boundary);
  } finally {
    observer.close();
  }
}
