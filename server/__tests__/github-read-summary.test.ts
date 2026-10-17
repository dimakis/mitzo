import { describe, expect, it } from 'vitest';
import { webPageContent } from '../web-page-content.js';
import { fetchPublicPage } from '../public-web-fetch.js';
import { fetchApprovedUrl } from '../approved-url-fetch.js';

const url = 'https://api.github.com/repos/example/project/issues?state=open&per_page=2';
const records = [
  {
    number: 1,
    title: 'Bug',
    state: 'open',
    html_url: 'https://github.com/example/project/issues/1',
    url: 'https://api.github.com/repos/example/project/issues/1',
    body: 'large body '.repeat(20000),
    user: { login: 'author', avatar_url: 'noise' },
    labels: [{ name: 'bug', color: 'noise' }],
  },
  {
    number: 2,
    title: 'Fix',
    state: 'open',
    url: 'https://api.github.com/repos/example/project/pulls/2',
    pull_request: { url: 'https://api.github.com/repos/example/project/pulls/2' },
    body: 'large body '.repeat(20000),
  },
];
const summary = (data: unknown, source = url) =>
  JSON.parse(webPageContent(JSON.stringify(data), 'application/json', source));

describe('structured GitHub list reads', () => {
  it('keeps issue and PR identities, selected fields and record links without repeating bodies', () => {
    const result = summary(records);
    expect(result).toMatchObject({
      view: 'github-list-summary',
      source: url,
      returned: 2,
      omitted: 0,
      issue_count_on_page: 1,
      pull_request_count_on_page: 1,
    });
    expect(result.items[0]).toMatchObject({
      number: 1,
      title: 'Bug',
      user: { login: 'author' },
      labels: [{ name: 'bug' }],
      url: records[0].url,
    });
    expect(JSON.stringify(result)).not.toContain('large body');
    expect(JSON.stringify(result)).not.toContain('avatar_url');
    expect(result.notice).toContain('individual');
    expect(result.pagination).toMatchObject({ page: '1', per_page: '2' });
  });

  it('summarizes commit lists with first-line messages, identity and verification', () => {
    const result = summary(
      [
        {
          sha: 'abc',
          url: 'https://api.github.com/repos/example/project/commits/abc',
          commit: {
            message: 'Fix retrieval\n\nLong explanation',
            author: { name: 'A', date: '2026-10-17' },
            verification: { verified: true, signature: 'huge signature' },
          },
        },
      ],
      'https://api.github.com/repos/example/project/commits?per_page=10',
    );
    expect(result.items[0]).toMatchObject({
      sha: 'abc',
      commit: {
        message: 'Fix retrieval',
        author: { name: 'A', date: '2026-10-17' },
        verification: { verified: true },
      },
    });
    expect(JSON.stringify(result)).not.toContain('Long explanation');
    expect(JSON.stringify(result)).not.toContain('huge signature');
  });

  it('keeps GitHub total_count separate from the records returned on one page', () => {
    const result = summary(
      {
        total_count: 187,
        check_runs: [
          {
            id: 1,
            name: 'CI',
            status: 'completed',
            conclusion: 'success',
            output: { text: 'huge details' },
          },
        ],
      },
      'https://api.github.com/repos/example/project/commits/abc/check-runs?per_page=1',
    );
    expect(result).toMatchObject({
      total_count: 187,
      returned: 1,
      items: [{ name: 'CI', conclusion: 'success' }],
    });
    expect(JSON.stringify(result)).not.toContain('huge details');
  });

  it('explicitly marks a bounded recursive tree as partial, including upstream truncation', () => {
    const result = summary(
      {
        sha: 'abc',
        truncated: true,
        tree: Array.from({ length: 105 }, (_, i) => ({
          path: `file-${i}`,
          type: 'blob',
          sha: String(i),
          url: `https://api.github.com/blobs/${i}`,
        })),
      },
      'https://api.github.com/repos/example/project/git/trees/main?recursive=1',
    );
    expect(result).toMatchObject({ returned: 100, omitted: 5, upstream_truncated: true });
    expect(result.items).toHaveLength(100);
    expect(result.notice).toContain('partial');
  });

  it.each([
    'https://api.github.com/repos/example/project/issues/1',
    'https://api.github.com/repos/example/project/unknown',
    'https://api.github.com.evil.test/repos/example/project/issues',
    'https://example.com/repos/example/project/issues',
  ])('keeps full individual records and other sources intact: %s', (source) => {
    const body = JSON.stringify({ body: 'Full source data', items: records });
    expect(webPageContent(body, 'application/json', source)).toBe(body);
  });

  it('preserves malformed provider JSON without inventing an empty list', () => {
    expect(webPageContent('{broken', 'application/json', url)).toBe('{broken');
  });

  it.each(['public', 'approved'] as const)(
    'retains real pagination links through the %s reader',
    async (kind) => {
      const next =
        'https://api.github.com/repos/example/project/issues?state=open&per_page=2&page=2';
      const link = `<${next}>; rel="next", <${next}>; rel="last"`;
      const target = {
        url,
        origin: 'https://api.github.com',
        addresses: [{ address: '93.184.216.34', family: 4 }],
      };
      const result =
        kind === 'public'
          ? await fetchPublicPage(url, new AbortController().signal, {
              resolve: async () => target.addresses,
              send: async () => ({
                status: 200,
                headers: { 'content-type': 'application/json', link },
                body: JSON.stringify(records),
              }),
            })
          : await fetchApprovedUrl(url, target, new AbortController().signal, {
              resolve: async () => target,
              read: async () => ({
                status: 200,
                type: 'application/json',
                link,
                body: JSON.stringify(records),
              }),
            });
      const data = JSON.parse(result.split('\n\n').slice(1).join('\n\n'));
      expect(data.pagination.next).toBe(next);
      expect(data.pagination.last).toBe(next);
      expect(data.items).toHaveLength(2);
      expect(result.length).toBeLessThan(4000);
    },
  );
});

it.each(['public', 'approved'] as const)(
  'allows an explicitly requested full GitHub list through the %s reader',
  async (kind) => {
    const target = {
      url,
      origin: 'https://api.github.com',
      addresses: [{ address: '93.184.216.34', family: 4 }],
    };
    const body = JSON.stringify(records);
    const output =
      kind === 'public'
        ? await fetchPublicPage(
            url,
            new AbortController().signal,
            {
              resolve: async () => target.addresses,
              send: async () => ({
                status: 200,
                headers: { 'content-type': 'application/json' },
                body,
              }),
            },
            undefined,
            'full',
          )
        : await fetchApprovedUrl(
            url,
            target,
            new AbortController().signal,
            {
              resolve: async () => target,
              read: async () => ({ status: 200, type: 'application/json', body }),
            },
            undefined,
            'full',
          );
    expect(output.split('\n\n').slice(1).join('\n\n')).toBe(body);
  },
);

it('retains pagination when a transport exposes repeated Link headers', async () => {
  const next = 'https://api.github.com/repos/example/project/issues?page=2';
  const output = await fetchPublicPage(url, new AbortController().signal, {
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    send: async () => ({
      status: 200,
      headers: {
        'content-type': 'application/json',
        link: [`<${next}>; rel="next"`, `<${next}>; rel="last"`],
      },
      body: JSON.stringify([]),
    }),
  });
  expect(JSON.parse(output.split('\n\n').slice(1).join('\n\n')).pagination).toMatchObject({
    next,
    last: next,
  });
});
