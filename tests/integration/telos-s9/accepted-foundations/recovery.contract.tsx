// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { createS9Fixture, cleanupS9Fixtures } from './fixture.js';
import { useTelosRoleSetup } from '../../../../frontend/src/hooks/useTelosRoleSetup';

// Import real Node owners under Node's module semantics; install only the DOM
// globals needed by the actual React hook. Vitest's JSDOM module transform turns
// import.meta.url into an HTTP URL, incompatible with real filesystem owners.
import { JSDOM } from 'jsdom';
let dom: JSDOM;
beforeAll(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://s9.test' });
  for (const name of [
    'window',
    'document',
    'localStorage',
    'navigator',
    'HTMLElement',
    'Node',
    'MutationObserver',
  ] as const)
    vi.stubGlobal(name, dom.window[name]);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterAll(() => {
  dom.window.close();
  vi.unstubAllGlobals();
});

beforeEach(() => localStorage.clear());
afterEach(async () => {
  cleanup();
  localStorage.clear();
  await cleanupS9Fixtures();
});
const intent = { itemId: 'outcome', role: 'lead' as const, mode: 'assign' as const };

it('CT03 accepted-source full boundary: definite real HTTP stale rejection permits fresh review of the same retained draft after reload', async () => {
  const f = await createS9Fixture();
  const options = {
    draftId: 'same-retained-draft',
    intent,
    settings: f.ordinary.input.settings,
    api: f.api,
  };
  const first = renderHook(() => useTelosRoleSetup(options));
  await act(async () => first.result.current.review());
  expect(first.result.current.canConfirm).toBe(true);
  expect(first.result.current.presentationRef).toMatchObject({
    id: expect.any(String),
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  f.changeBrief();
  await act(async () => first.result.current.confirm());
  expect(f.ordinary.resolvePreparation).not.toHaveBeenCalled();
  expect.soft(first.result.current.uncertain).toBe(false);
  expect.soft(first.result.current.locked).toBe(false);
  first.unmount();
  const reloaded = renderHook(() => useTelosRoleSetup(options));
  await act(async () => reloaded.result.current.review());
  expect(reloaded.result.current.canConfirm).toBe(true);
  expect(reloaded.result.current.context?.brief.revision).toBe(
    (await f.api.read('outcome')).revision,
  );
  await act(async () => reloaded.result.current.confirm());
  expect(reloaded.result.current.boundConversationId).toBeTruthy();
  expect(f.events.listSessions()).toHaveLength(2);
});

it('CT04 real committed response loss stays uncertain until exact hook/client/HTTP replay recovers the original allocation', async () => {
  const f = await createS9Fixture(),
    onBound = vi.fn();
  const setup = vi.spyOn(f.api, 'setupReviewedRole');
  const legacySetup = vi.spyOn(f.api, 'setupRole');
  const options = {
    draftId: 'uncertain-retained-draft',
    intent,
    settings: f.ordinary.input.settings,
    api: f.api,
    onBound,
  };
  const first = renderHook(() => useTelosRoleSetup(options));
  await act(async () => first.result.current.review());
  const presentation = structuredClone(first.result.current.presentation);
  const presentationRef = structuredClone(first.result.current.presentationRef);
  expect(presentationRef).toBeDefined();
  f.loseNextSetupResponse();
  await act(async () => first.result.current.confirm());
  expect(first.result.current.uncertain).toBe(true);
  expect(first.result.current.locked).toBe(true);
  const submitted = structuredClone(setup.mock.calls[0][0]);
  expect(submitted).toMatchObject({ version: 1, presentationRef });
  const original = (await f.api.read('outcome')).assignments[0].conversation.conversationId;
  first.unmount();
  f.restart();
  f.ordinary.resolvePreparation.mockClear();
  const reloaded = renderHook(() => useTelosRoleSetup(options));
  expect(reloaded.result.current.presentation).toEqual(presentation);
  expect(reloaded.result.current.presentationRef).toEqual(presentationRef);
  await act(async () => reloaded.result.current.retry());
  expect(reloaded.result.current.boundConversationId).toBe(original);
  expect(reloaded.result.current.uncertain).toBe(false);
  expect(onBound).toHaveBeenCalledExactlyOnceWith(original);
  expect(setup.mock.calls[1][0]).toEqual(submitted);
  expect(legacySetup).not.toHaveBeenCalled();
  expect(f.ordinary.resolvePreparation).not.toHaveBeenCalled();
  expect(f.events.listSessions()).toHaveLength(2);
});

// A 409 after an awaited preparation is not positive preallocation proof. This
// control crosses the real server and retains the exact request on reload.
it('CT04 post-intent HTTP conflict retains the original request across reload and cannot start a fresh review', async () => {
  const f = await createS9Fixture();
  const resolve = f.ordinary.resolvePreparation.getMockImplementation()!;
  f.ordinary.resolvePreparation.mockImplementationOnce(async (...args) => {
    const prepared = await resolve(...args);
    f.changeBrief();
    return prepared;
  });
  const setup = vi.spyOn(f.api, 'setupReviewedRole');
  const options = {
    draftId: 'post-intent-conflict',
    intent,
    settings: f.ordinary.input.settings,
    api: f.api,
  };
  const first = renderHook(() => useTelosRoleSetup(options));
  await act(async () => first.result.current.review());
  expect(first.result.current.canConfirm).toBe(true);
  await act(async () => first.result.current.confirm());
  await expect(setup.mock.results[0].value).rejects.toMatchObject({
    status: 409,
    code: 'conflict',
  });
  expect(first.result.current.uncertain).toBe(true);
  expect(first.result.current.locked).toBe(true);
  const original = structuredClone(setup.mock.calls[0][0]);
  first.unmount();
  f.restart();
  const reopened = renderHook(() => useTelosRoleSetup(options));
  await act(async () => reopened.result.current.review());
  expect(reopened.result.current.canConfirm).toBe(false);
  await act(async () => reopened.result.current.retry());
  expect(setup.mock.calls[1][0]).toEqual(original);
  expect(reopened.result.current.uncertain).toBe(true);
  expect(reopened.result.current.locked).toBe(true);
  expect(f.events.listSessions()).toHaveLength(1);
});
