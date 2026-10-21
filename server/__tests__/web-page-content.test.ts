import { expect, it, vi } from 'vitest';
import { fetchPublicPage } from '../public-web-fetch.js';
import { fetchApprovedUrl } from '../approved-url-fetch.js';
import { webPageContent } from '../web-page-content.js';

const target = {
  url: 'https://example.com/release',
  origin: 'https://example.com',
  addresses: [{ address: '93.184.216.34', family: 4 }],
};
const html = `<!doctype html><html><head><title>Release</title><script>${'metadata'.repeat(25000)}</script></head><body>
<nav>Navigation</nav><main><h1>Home Assistant release</h1><p>Home Connect &amp; dishwasher changes.</p>
<a href="/details">Full details</a><script>ignore-script</script><style>ignore-style</style></main><footer>Footer</footer></body></html>`;

it.each(['public', 'approved'] as const)(
  'reads HTML larger than 128 KB through the %s path',
  async (path) => {
    const read = vi.fn().mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'text/html' },
      type: 'text/html',
      body: html,
    });
    const output =
      path === 'public'
        ? await fetchPublicPage(target.url, new AbortController().signal, {
            resolve: async () => target.addresses,
            send: read,
          })
        : await fetchApprovedUrl(target.url, target, new AbortController().signal, {
            resolve: async () => target,
            read,
          });
    expect(output).toContain('Home Connect & dishwasher changes.');
    expect(output).toContain('https://example.com/details');
    expect(output).not.toContain('metadata');
    expect(output).not.toContain('ignore-script');
    expect(output).not.toContain('ignore-style');
    expect(read).toHaveBeenCalledOnce();
  },
);

it('keeps a long article intact rather than truncating it to 128 KB', async () => {
  const body = `<main><p>${'Readable article. '.repeat(10000)}</p><p>End of article.</p></main>`;
  const output = await fetchPublicPage(target.url, new AbortController().signal, {
    resolve: async () => target.addresses,
    send: async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body }),
  });
  expect(output).toContain('End of article.');
  expect(output.match(/Readable article\./g)).toHaveLength(10000);
});

it('does not alter structured or plain-text sources', async () => {
  const body = '{"page":"<script>source data</script>"}';
  expect(
    await fetchPublicPage(target.url, new AbortController().signal, {
      resolve: async () => target.addresses,
      send: async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body }),
    }),
  ).toContain(body);
});

it('handles wide HTML documents without relying on argument or recursion limits', () => {
  expect(
    webPageContent(`<main>${'<br>'.repeat(130000)}End of article.</main>`, 'text/html', target.url),
  ).toBe('End of article.');
});

it('keeps invalid, embedded-credential and non-web links as text without fetching them', () => {
  const output = webPageContent(
    '<main><a href="https://user:password@example.com">Account</a><a href="javascript:alert(1)">Action</a><a href="http://[invalid">Broken</a></main>',
    'text/html',
    target.url,
  );
  expect(output).toContain('Account');
  expect(output).toContain('Action');
  expect(output).not.toContain('password');
  expect(output).not.toContain('javascript:');
});

it('separates table cells and preserves preformatted code indentation', () => {
  const output = webPageContent(
    '<main><table><tr><th>Version</th><th>Status</th></tr><tr><td>2026.10</td><td>Released</td></tr></table><pre>def example():\n    if ready:\n        return True\n</pre></main>',
    'text/html',
    target.url,
  );
  expect(output).toMatch(/Version\s+Status/);
  expect(output).toMatch(/2026\.10\s+Released/);
  expect(output).toContain('def example():\n    if ready:\n        return True');
});

it.each([false, true])(
  'keeps generated link metadata proportional to source size (unique=%s)',
  (unique) => {
    const source = 'https://example.com/' + 'a'.repeat(3970);
    const body =
      '<main>' +
      Array.from({ length: 2000 }, (_, i) => `<a href="#${unique ? i : ''}">Link ${i}</a>`).join(
        '',
      ) +
      '<p>Article end.</p></main>';
    const output = webPageContent(body, 'text/html', source);
    expect(output.length).toBeLessThan(body.length * 5 + source.length);
    expect(output).toContain('Link 1999');
    expect(output).toContain('Article end.');
    if (unique) {
      expect(output).toContain('URL reference: #1999');
      expect(output).toContain(source);
    }
  },
);

it('uses the first valid document base and keeps rejecting unsafe link protocols and credentials', () => {
  const output = webPageContent(
    '<head><base href="javascript:bad"><base href="/docs/v2/"><base href="/other/"></head><body><main><a href="setup">Setup</a><a href="https://user:secret@example.com">Private</a></main></body>',
    'text/html',
    target.url,
  );
  expect(output).toContain('https://example.com/docs/v2/setup');
  expect(output).not.toContain('https://example.com/other/setup');
  expect(output).not.toContain('secret');
});

it('honors an empty first base href and empty same-document anchor href', () => {
  const output = webPageContent(
    '<head><base href=""><base href="/other/"></head><main><a href="setup">Setup</a><a href="">Self</a></main>',
    'text/html',
    target.url,
  );
  expect(output).toContain('https://example.com/setup');
  expect(output).toContain('https://example.com/release');
  expect(output).not.toContain('/other/setup');
});

it('ignores HTML-named elements in foreign namespaces when selecting the main content and base', () => {
  const output = webPageContent(
    '<svg><main>Not the article</main><base href="/wrong/" /></svg><main><a href="setup">Setup</a></main>',
    'text/html',
    target.url,
  );
  expect(output).toContain('https://example.com/setup');
  expect(output).not.toContain('/wrong/setup');
  expect(output).not.toContain('Not the article');
});

it('preserves XHTML source including self-closing non-void elements', () => {
  const body =
    '<html xmlns="http://www.w3.org/1999/xhtml"><head><script src="app.js" /></head><body><p>Article</p></body></html>';
  expect(webPageContent(body, 'application/xhtml+xml; charset=utf-8', target.url)).toBe(body);
});

it.each(['public', 'approved'] as const)(
  'reports a JavaScript shell as unreadable on the %s path',
  async (path) => {
    const read = vi.fn().mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'text/html' },
      type: 'text/html',
      body: '<html><head><title>Search</title></head><body><script>bootstrap()</script><main></main></body></html>',
    });
    const work =
      path === 'public'
        ? fetchPublicPage(target.url, new AbortController().signal, {
            resolve: async () => target.addresses,
            send: read,
          })
        : fetchApprovedUrl(target.url, target, new AbortController().signal, {
            resolve: async () => target,
            read,
          });
    await expect(work).rejects.toThrow('no readable content');
    expect(read).toHaveBeenCalledOnce();
  },
);

it.each(['public', 'approved'] as const)(
  'extracts a small quote from script-heavy HTML above 2 MiB on the %s path',
  async (path) => {
    const body = `<html><head><script>${'x'.repeat(3 * 1024 * 1024)}</script></head><body><main><h1>IBM quote</h1><p>USD 100.00, fixture timestamp.</p><a href="/quote">Source</a></main></body></html>`;
    const read = vi
      .fn()
      .mockResolvedValue({
        status: 200,
        headers: { 'content-type': 'text/html' },
        type: 'text/html',
        body,
      });
    const output =
      path === 'public'
        ? await fetchPublicPage(target.url, new AbortController().signal, {
            resolve: async () => target.addresses,
            send: read,
          })
        : await fetchApprovedUrl(target.url, target, new AbortController().signal, {
            resolve: async () => target,
            read,
          });
    expect(output).toContain('USD 100.00, fixture timestamp.');
    expect(output).toContain('https://example.com/quote');
    expect(Buffer.byteLength(output)).toBeLessThan(1000);
    expect(read).toHaveBeenCalledOnce();
  },
);

it.each(['text/plain', 'application/json', 'text/html'])(
  'rejects oversized readable %s with a recovery action instead of silently truncating it',
  (type) => {
    const text = 'x'.repeat(2 * 1024 * 1024 + 1);
    const body = type === 'text/html' ? `<main>${text}</main>` : text;
    expect(() => webPageContent(body, type, target.url)).toThrow(
      /readable content.*smaller.*search/i,
    );
  },
);

it('accepts a compact CSV quote on the single-approval public fetch path', async () => {
  const output = await fetchPublicPage(target.url, new AbortController().signal, {
    resolve: async () => target.addresses,
    send: async () => ({
      status: 200,
      headers: { 'content-type': 'text/csv; charset=utf-8' },
      body: 'Symbol,Price\nIBM,100.00',
    }),
  });
  expect(output).toContain('Symbol,Price\nIBM,100.00');
});
