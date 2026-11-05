// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useDraft } from '../useDraft';
import { useSavedChatDrafts } from '../useSavedChatDrafts';
import {
  chatDraftStorageKey,
  createChatDraft,
  getChatDraft,
  listChatDrafts,
  saveChatDraft,
} from '../../lib/chat-drafts';
import { acceptedComposerDraftKey } from '../../lib/composer-draft-proof';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function submitDraft() {
  const draft = {
    ...createChatDraft(),
    text: 'Already sent with a screenshot',
    images: [{ data: 'abc', preview: 'data:image/png;base64,abc', mediaType: 'image/png' }],
    contextBlocks: ['Selected context'],
  };
  saveChatDraft(draft);
  const composer = renderHook(() => useDraft(undefined, undefined, chatDraftStorageKey(draft.id)));
  const receipt = composer.result.current[4];
  const proof = receipt.capture()!;
  composer.unmount();
  return { draft, proof, receipt };
}

it('removes an accepted message from the mounted draft collection after its composer closes', () => {
  const { draft, proof, receipt } = submitDraft();
  const collection = renderHook(() => useSavedChatDrafts());
  expect(collection.result.current.map((item) => item.id)).toEqual([draft.id]);

  act(() => expect(receipt.recordAcceptance(proof)).toBe(true));

  expect(collection.result.current).toEqual([]);
  expect(listChatDrafts()).toEqual([]);
  // The original owner can still recover and consume its exact receipt.
  expect(getChatDraft(draft.id)?.text).toBe(draft.text);
  collection.unmount();
  expect(renderHook(() => useSavedChatDrafts()).result.current).toEqual([]);
});

it('excludes cold accepted drafts without reopening their composers', () => {
  const { proof } = submitDraft();
  localStorage.setItem(acceptedComposerDraftKey(proof.storageKey), JSON.stringify(proof));
  expect(renderHook(() => useSavedChatDrafts()).result.current).toEqual([]);
});

it.each(['text', 'images', 'contextBlocks', 'settings'] as const)(
  'keeps a newer persisted %s edit despite the older acceptance marker',
  (field) => {
    const { draft, proof } = submitDraft();
    localStorage.setItem(acceptedComposerDraftKey(proof.storageKey), JSON.stringify(proof));
    const collection = renderHook(() => useSavedChatDrafts());
    expect(collection.result.current).toEqual([]);
    const current = getChatDraft(draft.id)!;
    const updated = {
      ...current,
      ...(field === 'text' ? { text: 'New unsent thought' } : {}),
      ...(field === 'images' ? { images: [] } : {}),
      ...(field === 'contextBlocks' ? { contextBlocks: ['New context'] } : {}),
      ...(field === 'settings' ? { settings: { ...current.settings, mode: 'ask' as const } } : {}),
    };
    act(() => expect(saveChatDraft(updated)).toBe(true));
    expect(collection.result.current).toEqual([getChatDraft(draft.id)]);
  },
);

it('keeps identical next messages whose edit revoked the accepted revision', () => {
  const { draft, proof } = submitDraft();
  localStorage.setItem(acceptedComposerDraftKey(proof.storageKey), JSON.stringify(proof));
  // A different editor explicitly composes the same message again.
  localStorage.removeItem(acceptedComposerDraftKey(proof.storageKey));
  const composer = renderHook(() => useDraft(undefined, undefined, proof.storageKey));
  act(() => composer.result.current[1](draft.text));
  composer.unmount();
  localStorage.setItem(acceptedComposerDraftKey(proof.storageKey), JSON.stringify(proof));
  expect(listChatDrafts().map((item) => item.id)).toEqual([draft.id]);
});

it.each(['invalid JSON', JSON.stringify({ storageKey: 'another-draft', revisionToken: 'wrong' })])(
  'keeps drafts when the acceptance marker cannot prove their revision: %s',
  (marker) => {
    const { draft, proof } = submitDraft();
    localStorage.setItem(acceptedComposerDraftKey(proof.storageKey), marker);
    expect(listChatDrafts().map((item) => item.id)).toEqual([draft.id]);
  },
);
