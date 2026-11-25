// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useConversationContextArtifacts } from '../useConversationContextArtifacts';
import type {
  ConversationArtifactOption,
  ConversationJoiningOwner,
} from '../../lib/conversation-joining-review';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const catalog = [
  { artifactId: 'report', revision: 2, sha256: 'a'.repeat(64) },
] as unknown as ConversationArtifactOption[];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

it('keeps the last loaded catalog while the same owner refreshes or fails to refresh', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const reads = [
    deferred<ConversationArtifactOption[]>(),
    deferred<ConversationArtifactOption[]>(),
  ];
  let call = 0;
  const owner = {
    kind: 'application',
    sourceConversationId: 'source',
    loadArtifacts: vi.fn(() => reads[call++].promise),
  } as unknown as ConversationJoiningOwner;
  const view = renderHook(({ open }) => useConversationContextArtifacts(owner, open), {
    initialProps: { open: true },
  });
  await act(async () => reads[0].resolve(catalog));
  expect(view.result.current.artifacts).toBe(catalog);
  // Reopening the Starting context page refreshes, but never drops the catalog.
  view.rerender({ open: false });
  view.rerender({ open: true });
  expect(view.result.current.loading).toBe(true);
  expect(view.result.current.artifacts).toBe(catalog);
  await act(async () => reads[1].reject(new Error('offline')));
  expect(view.result.current.loading).toBe(false);
  expect(view.result.current.error).toMatch(/could not be read/);
  expect(view.result.current.artifacts).toBe(catalog);
});

it('never carries a catalog across owners', async () => {
  const first = {
    kind: 'application',
    sourceConversationId: 'first',
    loadArtifacts: vi.fn(async () => catalog),
  } as unknown as ConversationJoiningOwner;
  const pending = deferred<ConversationArtifactOption[]>();
  const second = {
    kind: 'application',
    sourceConversationId: 'second',
    loadArtifacts: vi.fn(() => pending.promise),
  } as unknown as ConversationJoiningOwner;
  const view = renderHook(({ owner }) => useConversationContextArtifacts(owner, true), {
    initialProps: { owner: first },
  });
  await act(async () => {});
  expect(view.result.current.artifacts).toBe(catalog);
  view.rerender({ owner: second });
  expect(view.result.current.artifacts).toBeUndefined();
  expect(view.result.current.loading).toBe(true);
});
