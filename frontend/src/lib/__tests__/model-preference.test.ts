import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_MODEL } from '../constants';

// Mock localStorage before importing the module under test
const store: Record<string, string> = {};
const localStorageMock = {
  getItem: vi.fn((key: string) => store[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    store[key] = value;
  }),
  clear: vi.fn(() => {
    for (const key of Object.keys(store)) delete store[key];
  }),
  removeItem: vi.fn((key: string) => {
    delete store[key];
  }),
};
vi.stubGlobal('localStorage', localStorageMock);

import { getPreferredModel, setPreferredModel, PREFERRED_MODEL_KEY } from '../model-preference';

describe('model-preference', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('returns DEFAULT_MODEL when nothing is stored', () => {
    expect(getPreferredModel()).toBe(DEFAULT_MODEL);
  });

  it('returns the stored model after setPreferredModel', () => {
    setPreferredModel('claude-opus-4-6');
    expect(getPreferredModel()).toBe('claude-opus-4-6');
  });

  it('persists to localStorage under the correct key', () => {
    setPreferredModel('claude-haiku-4-5');
    expect(localStorageMock.setItem).toHaveBeenCalledWith(PREFERRED_MODEL_KEY, 'claude-haiku-4-5');
  });

  it('returns DEFAULT_MODEL if localStorage throws', () => {
    localStorageMock.getItem.mockImplementationOnce(() => {
      throw new Error('quota exceeded');
    });
    expect(getPreferredModel()).toBe(DEFAULT_MODEL);
  });
});
