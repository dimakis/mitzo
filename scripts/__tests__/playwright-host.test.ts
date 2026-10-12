import { beforeEach, describe, expect, it, vi } from 'vitest';

const { launch, newPage, close } = vi.hoisted(() => ({
  launch: vi.fn(),
  newPage: vi.fn(),
  close: vi.fn(),
}));
vi.mock('@playwright/test', () => ({
  chromium: { launch },
  webkit: { launch },
  firefox: { launch },
}));

import { assertPlaywrightHost } from '../../tests/support/playwright-host';
import { checkBrowserStartup } from '../../tests/support/playwright-browser-startup';

describe('Playwright host admission', () => {
  it('refuses macOS Seatbelt before a browser can be launched', () => {
    expect(() => assertPlaywrightHost('darwin', { CODEX_SANDBOX: 'seatbelt' }, [])).toThrow(
      /outside.*sandbox/i,
    );
    expect(launch).not.toHaveBeenCalled();
  });

  it.each([['--list'], ['--help'], ['-h']])('allows discovery with %s', (flag) => {
    expect(() =>
      assertPlaywrightHost('darwin', { CODEX_SANDBOX: 'seatbelt' }, [flag]),
    ).not.toThrow();
  });

  it('allows an unsandboxed Mac and Linux CI', () => {
    expect(() => assertPlaywrightHost('darwin', {}, [])).not.toThrow();
    expect(() => assertPlaywrightHost('linux', { CODEX_SANDBOX: 'seatbelt' }, [])).not.toThrow();
  });
});

describe('browser startup preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    launch.mockResolvedValue({ newPage, close });
    newPage.mockResolvedValue({});
    close.mockResolvedValue(undefined);
  });

  it('checks each configured engine once, including opening a page, then closes it', async () => {
    await checkBrowserStartup([
      { name: 'phone', use: { browserName: 'chromium' } },
      { name: 'desktop', use: { browserName: 'chromium' } },
      { name: 'iphone', use: { browserName: 'webkit' } },
    ]);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(newPage).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('stops at the first launch failure with project and original error evidence', async () => {
    launch.mockRejectedValueOnce(new Error('bootstrap_check_in: Permission denied (1100)'));
    await expect(
      checkBrowserStartup([
        { name: 'iphone', use: { browserName: 'webkit' } },
        { name: 'desktop', use: { browserName: 'chromium' } },
      ]),
    ).rejects.toThrow(/iphone.*webkit[\s\S]*Permission denied/);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('closes a browser even when page creation fails', async () => {
    newPage.mockRejectedValueOnce(new Error('browserContext.newPage: browser closed'));
    await expect(
      checkBrowserStartup([{ name: 'phone', use: { browserName: 'webkit' } }]),
    ).rejects.toThrow(/browser closed/);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('honors project launch settings and does not deduplicate different channels', async () => {
    await checkBrowserStartup([
      { name: 'shell', use: { browserName: 'chromium', launchOptions: { timeout: 1234 } } },
      { name: 'chrome', use: { browserName: 'chromium', channel: 'chrome', headless: false } },
    ]);
    expect(launch).toHaveBeenNthCalledWith(1, { headless: true, timeout: 1234 });
    expect(launch).toHaveBeenNthCalledWith(2, { headless: false, channel: 'chrome' });
  });
});
