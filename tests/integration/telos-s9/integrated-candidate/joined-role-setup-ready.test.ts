import { EventEmitter } from 'node:events';
import type { Page, Request, Response } from '@playwright/test';
import { afterEach, expect, it, vi } from 'vitest';
import {
  actToItemChatChooser,
  actToReviewedRoleSetup,
  actToRoleSetupDraft,
} from './joined-role-setup-ready';

const origin = 'http://127.0.0.1:4321';
const target = { origin, itemId: 'studio', role: 'lead' as const };
function review() {
  const item = { itemId: 'studio', revision: 'reviewed', title: 'Studio' };
  return {
    version: 1,
    selection: {
      version: 1,
      itemId: 'studio',
      role: 'lead',
      brief: { revision: 'reviewed', sha256: 'a'.repeat(64), text: 'Retained' },
      parentCriteria: [],
      overallGoal: { itemId: 'studio', revision: 'reviewed', text: 'Goal' },
      sources: [],
      artifacts: [],
    },
    presentationRef: { id: '48362676-9caa-4766-9d02-6a7b528cc521', sha256: 'b'.repeat(64) },
    presentation: {
      version: 1,
      contextSha256: 'c'.repeat(64),
      reviewedAt: '2026-10-28T18:00:00Z',
      item,
      overallGoal: item,
      parents: [],
      sources: [],
      artifacts: [],
    },
  };
}
function fixture() {
  const events = new EventEmitter();
  Object.assign(events, { url: () => origin + '/todos/studio?view=Chat&chooseChat=1' });
  const page = events as unknown as Page;
  const request = (
    input: unknown = { itemId: 'studio', role: 'lead' },
    url = origin + '/api/telos/work/roles/review',
    method = 'POST',
  ) => {
    const value = {
      url: () => url,
      method: () => method,
      postDataJSON: () => input,
    } as unknown as Request;
    return value;
  };
  const start = (request: Request) => events.emit('request', request);
  const respond = (
    request: Request,
    options: {
      status?: number;
      finished?: Promise<Error | null>;
      body?: unknown | Promise<unknown>;
    } = {},
  ) => {
    const response = {
      url: request.url,
      request: () => request,
      status: () => options.status ?? 200,
      finished: () => options.finished ?? Promise.resolve(null),
      json: () => Promise.resolve(options.body ?? review()),
    } as unknown as Response;
    events.emit('response', response);
  };
  return { page, events, request, start, respond };
}
afterEach(() => vi.useRealTimers());
it('arms before the real action and awaits complete exact review bytes within the existing ten-second contract', async () => {
  const f = fixture();
  let finish!: () => void;
  let body!: () => void;
  let completed = false;
  const finished = new Promise<null>((resolve) => {
    finish = () => resolve(null);
  });
  const bytes = new Promise<unknown>((resolve) => {
    body = () => resolve(review());
  });
  const action = vi.fn(async () => {
    expect(f.events.listenerCount('request')).toBe(1);
    const r = f.request();
    f.start(r);
    f.respond(r, { finished, body: bytes });
  });
  const work = actToReviewedRoleSetup(f.page, target, action).then(() => {
    completed = true;
  });
  await Promise.resolve();
  expect(completed).toBe(false);
  finish();
  await Promise.resolve();
  expect(completed).toBe(false);
  body();
  await work;
  expect(action).toHaveBeenCalledOnce();
  expect(f.events.listenerCount('response')).toBe(0);
  expect(f.events.listenerCount('request')).toBe(0);
});
function linkedWork() {
  return {
    itemId: 'studio',
    kind: 'work_item',
    parentId: null,
    revision: 'a'.repeat(64),
    links: [
      {
        version: 1,
        linkId: 'retained-link',
        itemId: 'studio',
        linkedAt: '2026-10-30T10:00:00Z',
        linkedBy: 'operator:offline',
        availability: 'available',
        attemptId: null,
        role: 'worker',
        conversation: { namespace: 'mitzo', conversationId: 'worker-chat' },
      },
    ],
    assignments: [],
    sources: [],
    attempts: [],
  };
}
const chooserTarget = { origin, itemId: 'studio', conversationId: 'worker-chat' };
it('observes fresh exact chooser data before applying the existing DOM assertions', async () => {
  vi.useFakeTimers();
  const f = fixture(),
    url = origin + '/api/telos/work/items/studio';
  const old = f.request(undefined, url, 'GET');
  f.start(old);
  Object.assign(f.page, { url: () => origin + '/chat/worker-chat' });
  let completed = false;
  const work = actToItemChatChooser(f.page, chooserTarget, async () => {
    const departing = f.request(undefined, url, 'GET');
    f.start(departing);
    Object.assign(f.page, { url: () => origin + '/todos/studio?view=Chat&chooseChat=1' });
    f.respond(departing, { body: linkedWork() });
    f.respond(old, { body: linkedWork() });
    for (const r of [
      f.request(undefined, url, 'POST'),
      f.request(undefined, url.replace(origin, 'https://foreign.invalid'), 'GET'),
      f.request(undefined, origin + '/api/telos/work/items/other', 'GET'),
    ]) {
      f.start(r);
      f.respond(r, { body: linkedWork() });
    }
    setTimeout(() => {
      const r = f.request(undefined, url, 'GET');
      f.start(r);
      f.respond(r, { body: linkedWork() });
    }, 6000);
  }).then(() => {
    completed = true;
  });
  await vi.advanceTimersByTimeAsync(5000);
  expect(completed).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  await work;
  expect(f.events.listenerCount('request')).toBe(0);
  expect(f.events.listenerCount('response')).toBe(0);
});
it.each(['status', 'finished', 'schema', 'item', 'conversation', 'destination', 'deadline'])(
  'refuses invalid chooser readiness: %s',
  async (failure) => {
    vi.useFakeTimers();
    const f = fixture(),
      body = linkedWork();
    if (failure === 'item') body.itemId = 'other';
    if (failure === 'conversation') body.links[0].conversation.conversationId = 'other';
    if (failure === 'destination')
      Object.assign(f.page, { url: () => origin + '/todos/other?view=Chat&chooseChat=1' });
    const work = actToItemChatChooser(f.page, chooserTarget, async () => {
      const r = f.request(undefined, origin + '/api/telos/work/items/studio', 'GET');
      f.start(r);
      f.respond(r, {
        status: failure === 'status' ? 503 : 200,
        body: failure === 'schema' ? {} : body,
        finished:
          failure === 'deadline'
            ? new Promise(() => {})
            : Promise.resolve(failure === 'finished' ? Error('Aborted') : null),
      });
    });
    const refused = expect(work).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10000);
    await refused;
    expect(f.events.listenerCount('request')).toBe(0);
    expect(f.events.listenerCount('response')).toBe(0);
  },
);
it('ignores old requests, foreign origin/item/role and non-POST responses before the fresh clicked review', async () => {
  const f = fixture();
  const old = f.request();
  f.start(old);
  let completed = false;
  const work = actToReviewedRoleSetup(f.page, target, async () => {
    f.respond(old);
    for (const r of [
      f.request({ itemId: 'other', role: 'lead' }),
      f.request({ itemId: 'studio', role: 'advisor' }),
      f.request(undefined, 'https://foreign.invalid/api/telos/work/roles/review'),
      f.request(undefined, undefined, 'GET'),
    ]) {
      f.start(r);
      f.respond(r);
    }
  }).then(() => {
    completed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(completed).toBe(false);
  const r = f.request();
  f.start(r);
  f.respond(r);
  await work;
  expect(f.events.listenerCount('request')).toBe(0);
});
it.each(['status', 'finished', 'schema', 'response-identity'])(
  'rejects a fresh exact response with invalid %s',
  async (failure) => {
    const f = fixture();
    const body = review();
    if (failure === 'response-identity') {
      body.selection.role = 'advisor';
    }
    await expect(
      actToReviewedRoleSetup(f.page, target, async () => {
        const r = f.request();
        f.start(r);
        f.respond(r, {
          status: failure === 'status' ? 409 : 200,
          finished: Promise.resolve(failure === 'finished' ? Error('Aborted') : null),
          body: failure === 'schema' ? {} : body,
        });
      }),
    ).rejects.toThrow();
    expect(f.events.listenerCount('request')).toBe(0);
  },
);
it('the fixed ten-second deadline includes a response body that never finishes', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const work = actToReviewedRoleSetup(f.page, target, async () => {
    const r = f.request();
    f.start(r);
    f.respond(r, { finished: new Promise(() => {}) });
  });
  const rejected = expect(work).rejects.toThrow('response deadline');
  await vi.advanceTimersByTimeAsync(10000);
  await rejected;
  expect(f.events.listenerCount('request')).toBe(0);
});
it('preserves action failures and removes the freshness listener', async () => {
  vi.useFakeTimers();
  const f = fixture();
  await expect(
    actToReviewedRoleSetup(f.page, target, async () => {
      throw Error('Click failed');
    }),
  ).rejects.toThrow('Click failed');
  expect(f.events.listenerCount('request')).toBe(0);
  await vi.advanceTimersByTimeAsync(10000);
});

it('waits past the former five-second rendering race without extending its ten-second review deadline', async () => {
  vi.useFakeTimers();
  const f = fixture();
  let completed = false;
  const work = actToReviewedRoleSetup(f.page, target, async () => {
    setTimeout(() => {
      const r = f.request();
      f.start(r);
      f.respond(r);
    }, 6000);
  }).then(() => {
    completed = true;
  });
  await vi.advanceTimersByTimeAsync(5000);
  expect(completed).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  await work;
  expect(f.events.listenerCount('response')).toBe(0);
  expect(f.events.listenerCount('request')).toBe(0);
});

it('arms before configuration but gives only the review phase its existing ten-second deadline', async () => {
  vi.useFakeTimers();
  const f = fixture();
  let finish!: () => void;
  let completed = false;
  const finished = new Promise<null>((yes) => {
    finish = () => yes(null);
  });
  const work = actToReviewedRoleSetup(f.page, target, async () => {
    // These stand for several unchanged independently bounded settings clicks.
    await new Promise<void>((yes) => setTimeout(yes, 12000));
    const r = f.request();
    f.start(r);
    f.respond(r, { finished });
  }).then(() => {
    completed = true;
  });
  await vi.advanceTimersByTimeAsync(12000);
  expect(completed).toBe(false);
  await vi.advanceTimersByTimeAsync(9000);
  expect(completed).toBe(false);
  finish();
  await work;
  expect(f.events.listenerCount('request')).toBe(0);
  expect(f.events.listenerCount('response')).toBe(0);
});
function inventory() {
  return {
    version: 1,
    authority: 'configuration-only',
    defaultLocation: 'openshell',
    capabilityRevision: 'offline',
    accounts: [],
    targets: [],
    routes: [],
    locations: [],
    agentProfiles: [],
  };
}
it('waits for a fresh new-draft inventory while ignoring old or session-specific reads', async () => {
  const f = fixture();
  const url = origin + '/api/chat/runtime/capabilities?workspaceDefaults=1';
  const old = f.request(undefined, url, 'GET');
  f.start(old);
  let completed = false;
  const work = actToRoleSetupDraft(f.page, origin, async () => {
    f.respond(old, { body: inventory() });
    for (const path of [
      url + '&sessionId=peer',
      url.replace(origin, 'https://foreign.invalid'),
      origin + '/api/chat/runtime/capabilities',
    ]) {
      const r = f.request(undefined, path, 'GET');
      f.start(r);
      f.respond(r, { body: inventory() });
    }
  }).then(() => {
    completed = true;
  });
  await new Promise((yes) => setTimeout(yes, 0));
  expect(completed).toBe(false);
  const r = f.request(undefined, url, 'GET');
  f.start(r);
  f.respond(r, { body: inventory() });
  await work;
  expect(f.events.listenerCount('request')).toBe(0);
  expect(f.events.listenerCount('response')).toBe(0);
});
it.each(['status', 'schema', 'body-deadline'])(
  'refuses new-draft inventory %s before settings assertions',
  async (failure) => {
    vi.useFakeTimers();
    const f = fixture();
    const work = actToRoleSetupDraft(f.page, origin, async () => {
      const r = f.request(
        undefined,
        origin + '/api/chat/runtime/capabilities?workspaceDefaults=1',
        'GET',
      );
      f.start(r);
      f.respond(r, {
        status: failure === 'status' ? 503 : 200,
        body: failure === 'schema' ? {} : inventory(),
        finished: failure === 'body-deadline' ? new Promise(() => {}) : Promise.resolve(null),
      });
    });
    const refused = expect(work).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10000);
    await refused;
    expect(f.events.listenerCount('request')).toBe(0);
    expect(f.events.listenerCount('response')).toBe(0);
  },
);
