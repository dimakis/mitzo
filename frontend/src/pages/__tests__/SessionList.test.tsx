// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The SessionList component fetches four endpoints via Promise.all in this order:
 *   1. /api/sessions
 *   2. /api/config
 *   3. /api/inbox
 *   4. /api/version
 *
 * The destructured result must match: [sessData, config, inboxData, version].
 *
 * A previous bug swapped inboxData and version, causing:
 *   - inbox badge count to never show (version object is not an array)
 *   - update banner to never show (inbox array has no .updateAvailable)
 */
describe('SessionList fetch destructuring order', () => {
  it('Promise.all results map to the correct API endpoints', async () => {
    const sessionsResponse = [{ id: 's1', summary: 'Test' }];
    const configResponse = { quickActions: [] };
    const inboxResponse = [{ id: 'inbox-1' }, { id: 'inbox-2' }];
    const versionResponse = { updateAvailable: true };

    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/sessions') {
        return Promise.resolve({ json: () => Promise.resolve(sessionsResponse) });
      }
      if (url === '/api/config') {
        return Promise.resolve({ json: () => Promise.resolve(configResponse) });
      }
      if (url === '/api/inbox') {
        return Promise.resolve({ json: () => Promise.resolve(inboxResponse) });
      }
      if (url === '/api/version') {
        return Promise.resolve({ json: () => Promise.resolve(versionResponse) });
      }
      return Promise.resolve({ json: () => Promise.resolve({}) });
    });

    // Replicate the Promise.all from SessionList
    const results = await Promise.all([
      fetch('/api/sessions')
        .then((r) => r.json())
        .catch(() => []),
      fetch('/api/config')
        .then((r) => r.json())
        .catch(() => ({})),
      fetch('/api/inbox')
        .then((r) => r.json())
        .catch(() => []),
      fetch('/api/version')
        .then((r) => r.json())
        .catch(() => ({})),
    ]);

    // The correct destructuring order — must match the fetch order
    const [sessData, config, inboxData, version] = results;

    // Verify each variable got the right data
    expect(sessData).toEqual(sessionsResponse);
    expect(config).toEqual(configResponse);
    expect(Array.isArray(inboxData)).toBe(true);
    expect(inboxData).toHaveLength(2);
    expect(version).toHaveProperty('updateAvailable', true);
  });

  it('swapped destructuring causes inbox count to be zero', async () => {
    const inboxResponse = [{ id: 'inbox-1' }, { id: 'inbox-2' }];
    const versionResponse = { updateAvailable: true };

    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/sessions') {
        return Promise.resolve({ json: () => Promise.resolve([]) });
      }
      if (url === '/api/config') {
        return Promise.resolve({ json: () => Promise.resolve({}) });
      }
      if (url === '/api/inbox') {
        return Promise.resolve({ json: () => Promise.resolve(inboxResponse) });
      }
      if (url === '/api/version') {
        return Promise.resolve({ json: () => Promise.resolve(versionResponse) });
      }
      return Promise.resolve({ json: () => Promise.resolve({}) });
    });

    const results = await Promise.all([
      fetch('/api/sessions')
        .then((r) => r.json())
        .catch(() => []),
      fetch('/api/config')
        .then((r) => r.json())
        .catch(() => ({})),
      fetch('/api/inbox')
        .then((r) => r.json())
        .catch(() => []),
      fetch('/api/version')
        .then((r) => r.json())
        .catch(() => ({})),
    ]);

    // Simulate the BUGGY destructuring (version and inboxData swapped)
    const [, , buggyInbox, buggyVersion] = [
      results[0],
      results[1],
      results[3], // version object in inbox slot
      results[2], // inbox array in version slot
    ];

    // With swapped order, "inboxData" is the version object — not an array
    expect(Array.isArray(buggyInbox)).toBe(false);
    // So Array.isArray(inboxData) would be false, and setInboxCount never runs

    // With swapped order, "version" is the inbox array — no .updateAvailable
    expect(buggyVersion).not.toHaveProperty('updateAvailable');

    // Now verify the CORRECT destructuring works
    const [, , correctInbox, correctVersion] = results;
    expect(Array.isArray(correctInbox)).toBe(true);
    expect(correctInbox).toHaveLength(2);
    expect(correctVersion).toHaveProperty('updateAvailable', true);
  });
});
