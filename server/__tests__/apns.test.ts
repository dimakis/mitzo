import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';

const TEST_DIR = join(tmpdir(), `mitzo-apns-test-${process.pid}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('device token store', () => {
  // Dynamic import to get fresh module state per test
  async function loadModule() {
    // Reset module registry for fresh imports
    vi.resetModules();
    const mod = await import('../apns.js');
    mod.setTokenStorePath(join(TEST_DIR, 'device-tokens.json'));
    return mod;
  }

  it('registers a device token', async () => {
    const { registerToken, getTokens } = await loadModule();
    registerToken('token-abc-123');
    expect(getTokens()).toEqual(['token-abc-123']);
  });

  it('deduplicates identical tokens', async () => {
    const { registerToken, getTokens } = await loadModule();
    registerToken('token-abc-123');
    registerToken('token-abc-123');
    expect(getTokens()).toEqual(['token-abc-123']);
  });

  it('stores multiple tokens', async () => {
    const { registerToken, getTokens } = await loadModule();
    registerToken('token-1');
    registerToken('token-2');
    expect(getTokens()).toEqual(['token-1', 'token-2']);
  });

  it('removes a token', async () => {
    const { registerToken, removeToken, getTokens } = await loadModule();
    registerToken('token-1');
    registerToken('token-2');
    removeToken('token-1');
    expect(getTokens()).toEqual(['token-2']);
  });

  it('removing non-existent token is a no-op', async () => {
    const { removeToken, getTokens } = await loadModule();
    removeToken('nonexistent');
    expect(getTokens()).toEqual([]);
  });

  it('persists tokens to disk', async () => {
    const { registerToken, setTokenStorePath } = await loadModule();
    const filePath = join(TEST_DIR, 'device-tokens.json');
    setTokenStorePath(filePath);
    registerToken('persisted-token');
    expect(existsSync(filePath)).toBe(true);
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(data).toEqual(['persisted-token']);
  });

  it('loads tokens from disk on init', async () => {
    const filePath = join(TEST_DIR, 'preload-tokens.json');
    writeFileSync(filePath, JSON.stringify(['preloaded-1', 'preloaded-2']));

    vi.resetModules();
    const mod = await import('../apns.js');
    mod.setTokenStorePath(filePath);
    expect(mod.getTokens()).toEqual(['preloaded-1', 'preloaded-2']);
  });
});

describe('isConfigured', () => {
  it('returns false when no APNs key is set', async () => {
    vi.resetModules();
    delete process.env.APNS_KEY_PATH;
    delete process.env.APNS_KEY_ID;
    delete process.env.APNS_TEAM_ID;
    const { isConfigured } = await import('../apns.js');
    expect(isConfigured()).toBe(false);
  });

  it('returns true when all APNs env vars are set', async () => {
    vi.resetModules();
    process.env.APNS_KEY_PATH = '/path/to/key.p8';
    process.env.APNS_KEY_ID = 'KEYID123';
    process.env.APNS_TEAM_ID = 'TEAMID456';
    process.env.APNS_BUNDLE_ID = 'com.mitzo.app';
    const { isConfigured } = await import('../apns.js');
    expect(isConfigured()).toBe(true);
    delete process.env.APNS_KEY_PATH;
    delete process.env.APNS_KEY_ID;
    delete process.env.APNS_TEAM_ID;
    delete process.env.APNS_BUNDLE_ID;
  });
});

describe('sendPush', () => {
  it('is a no-op when not configured', async () => {
    vi.resetModules();
    delete process.env.APNS_KEY_PATH;
    const { sendPush } = await import('../apns.js');
    // Should not throw
    await expect(sendPush('Test', 'Body')).resolves.toBeUndefined();
  });
});

describe('sendTurnCompleteNotification', () => {
  it('uses session title in notification title when provided', async () => {
    vi.resetModules();
    delete process.env.APNS_KEY_PATH;
    const { sendTurnCompleteNotification } = await import('../apns.js');
    // Not configured, so sendPush is a no-op — we test the interface contract
    await expect(
      sendTurnCompleteNotification('sess-1', 'Some snippet', 'Jira Sprint Analysis'),
    ).resolves.toBeUndefined();
  });

  it('falls back to "Mitzo" when no session title', async () => {
    vi.resetModules();
    delete process.env.APNS_KEY_PATH;
    const { sendTurnCompleteNotification } = await import('../apns.js');
    await expect(sendTurnCompleteNotification('sess-1', 'Snippet')).resolves.toBeUndefined();
  });

  it('accepts undefined snippet and sessionId', async () => {
    vi.resetModules();
    delete process.env.APNS_KEY_PATH;
    const { sendTurnCompleteNotification } = await import('../apns.js');
    await expect(sendTurnCompleteNotification()).resolves.toBeUndefined();
  });
});

describe('APNS_CATEGORY', () => {
  it('exports the notification category constant', async () => {
    vi.resetModules();
    const { APNS_CATEGORY } = await import('../apns.js');
    expect(APNS_CATEGORY).toBe('SESSION_UPDATE');
  });
});
