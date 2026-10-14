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
