import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process before importing module under test
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'child_process';
import { getLocalCommit, getRemoteCommit, isUpdateAvailable } from '../git-version.js';

const mockExec = vi.mocked(execFileSync);

describe('git-version', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getLocalCommit', () => {
    it('returns the current HEAD commit hash', () => {
      mockExec.mockReturnValueOnce(Buffer.from('abc1234\n'));
      expect(getLocalCommit()).toBe('abc1234');
    });

    it('returns null on error', () => {
      mockExec.mockImplementationOnce(() => {
        throw new Error('not a git repo');
      });
      expect(getLocalCommit()).toBeNull();
    });
  });

  describe('getRemoteCommit', () => {
    it('returns the remote main commit hash after fetch', () => {
      mockExec.mockReturnValueOnce(Buffer.from('')); // git fetch
      mockExec.mockReturnValueOnce(Buffer.from('def5678\n')); // rev-parse
      expect(getRemoteCommit()).toBe('def5678');
    });

    it('returns null if fetch fails', () => {
      mockExec.mockImplementationOnce(() => {
        throw new Error('network error');
      });
      expect(getRemoteCommit()).toBeNull();
    });

    it('returns null if rev-parse fails after successful fetch', () => {
      mockExec.mockReturnValueOnce(Buffer.from('')); // git fetch succeeds
      mockExec.mockImplementationOnce(() => {
        throw new Error('unknown revision');
      });
      expect(getRemoteCommit()).toBeNull();
    });
  });

  describe('isUpdateAvailable', () => {
    it('returns true when local and remote differ', () => {
      mockExec.mockReturnValueOnce(Buffer.from('abc1234\n')); // local
      mockExec.mockReturnValueOnce(Buffer.from('')); // fetch
      mockExec.mockReturnValueOnce(Buffer.from('def5678\n')); // remote
      expect(isUpdateAvailable()).toBe(true);
    });

    it('returns false when local and remote match', () => {
      mockExec.mockReturnValueOnce(Buffer.from('abc1234\n')); // local
      mockExec.mockReturnValueOnce(Buffer.from('')); // fetch
      mockExec.mockReturnValueOnce(Buffer.from('abc1234\n')); // remote
      expect(isUpdateAvailable()).toBe(false);
    });

    it('returns false when local check fails', () => {
      mockExec.mockImplementationOnce(() => {
        throw new Error('git error');
      });
      expect(isUpdateAvailable()).toBe(false);
    });

    it('returns false when remote check fails', () => {
      mockExec.mockReturnValueOnce(Buffer.from('abc1234\n')); // local succeeds
      mockExec.mockReturnValueOnce(Buffer.from('')); // fetch succeeds
      mockExec.mockImplementationOnce(() => {
        throw new Error('unknown revision');
      }); // rev-parse fails
      expect(isUpdateAvailable()).toBe(false);
    });
  });
});
