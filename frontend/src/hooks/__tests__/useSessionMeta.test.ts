// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useSessionMeta } from '../useSessionMeta.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

const META_RESPONSE = {
  sessionId: 'sess-abc123',
  branch: 'feat/my-feature',
  wtId: 'wt-xyz',
  cwd: '/tmp/repo',
  mode: 'agent',
  isActive: false,
  totalTokens: 9500,
  totalCostUsd: 0.05,
  numTurns: 4,
};

describe('useSessionMeta', () => {
  const dispatch = vi.fn();
  const tokenDispatch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches metadata and dispatches SESSION_INFO', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(META_RESPONSE),
    });

    renderHook(() => useSessionMeta('sess-abc123', dispatch, tokenDispatch));

    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        type: 'SESSION_INFO',
        branch: 'feat/my-feature',
        isWorktree: true,
        wtId: 'wt-xyz',
      });
    });
  });

  it('dispatches TOKEN_UPDATE when numTurns > 0', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(META_RESPONSE),
    });

    renderHook(() => useSessionMeta('sess-abc123', dispatch, tokenDispatch));

    await waitFor(() => {
      expect(tokenDispatch).toHaveBeenCalledWith({
        type: 'TOKEN_UPDATE',
        agentContext: 0,
        sessionTotal: 9500,
        numTurns: 4,
        turnIndex: 4,
      });
    });
  });

  it('does not fetch when sessionId is undefined', () => {
    renderHook(() => useSessionMeta(undefined, dispatch, tokenDispatch));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not dispatch on 404', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    renderHook(() => useSessionMeta('unknown', dispatch, tokenDispatch));

    // Wait a tick to ensure no dispatches
    await new Promise((r) => setTimeout(r, 50));
    expect(dispatch).not.toHaveBeenCalled();
    expect(tokenDispatch).not.toHaveBeenCalled();
  });

  it('sets isWorktree false when wtId is null', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ...META_RESPONSE, wtId: null }),
    });

    renderHook(() => useSessionMeta('sess-abc123', dispatch, tokenDispatch));

    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ isWorktree: false, wtId: undefined }),
      );
    });
  });

  it('hydrates tokens but skips SESSION_INFO when branch is null', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ...META_RESPONSE, branch: null, wtId: null }),
    });

    renderHook(() => useSessionMeta('sess-abc123', dispatch, tokenDispatch));

    await waitFor(() => {
      expect(tokenDispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'TOKEN_UPDATE', sessionTotal: 9500 }),
      );
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('skips TOKEN_UPDATE when numTurns is 0', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ...META_RESPONSE, numTurns: 0 }),
    });

    renderHook(() => useSessionMeta('sess-abc123', dispatch, tokenDispatch));

    await waitFor(() => {
      expect(dispatch).toHaveBeenCalled();
    });
    expect(tokenDispatch).not.toHaveBeenCalled();
  });
});
