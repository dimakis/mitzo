// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  loadAgentLibraryWorkingCopy,
  saveAgentLibraryWorkingCopy,
} from './agent-library-working-copy';
import { newAgentDefinition } from './agent-library';

afterEach(() => {
  vi.restoreAllMocks();
  saveAgentLibraryWorkingCopy(null);
  sessionStorage.clear();
});
const copy = () => ({
  saveKey: crypto.randomUUID(),
  editor: {
    profileId: 'new-agent',
    expectedVersion: 0,
    baseRevision: 0,
    publishedRevision: null,
    definition: {
      ...newAgentDefinition(),
      name: '',
      role: 'unfinished role ',
      acceptanceCriteria: [' ', ''],
    },
  },
});
it('retains raw incomplete editor fields and the exact retry key', () => {
  const value = copy();
  expect(saveAgentLibraryWorkingCopy(value)).toBe(true);
  expect(loadAgentLibraryWorkingCopy()).toEqual(value);
});
it('rejects malformed browser recovery data', () => {
  sessionStorage.setItem(
    'mitzo-agent-library-working-copy',
    JSON.stringify({ version: 1, editor: { definition: 'invalid' }, saveKey: 'invalid' }),
  );
  expect(loadAgentLibraryWorkingCopy()).toBeNull();
});
it('keeps a tab-local memory copy if browser storage is unavailable', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('Unavailable');
  });
  const value = copy();
  expect(saveAgentLibraryWorkingCopy(value)).toBe(false);
  expect(loadAgentLibraryWorkingCopy()).toEqual(value);
  saveAgentLibraryWorkingCopy(null);
  expect(loadAgentLibraryWorkingCopy()).toBeNull();
});

it('does not restore older stored edits after a failed write or discard', () => {
  saveAgentLibraryWorkingCopy(copy());
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('Full');
  });
  const newer = copy();
  newer.editor.definition.name = 'Newest';
  saveAgentLibraryWorkingCopy(newer);
  expect(loadAgentLibraryWorkingCopy()).toEqual(newer);
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw Error('Blocked');
  });
  saveAgentLibraryWorkingCopy(null);
  expect(loadAgentLibraryWorkingCopy()).toBeNull();
});
