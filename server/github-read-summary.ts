type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const fields = (value: unknown, names: readonly string[]) =>
  Object.fromEntries(
    names
      .filter((name) => Object.hasOwn(record(value), name))
      .map((name) => [name, record(value)[name]]),
  );

const ITEM_FIELDS = [
  'id',
  'number',
  'title',
  'name',
  'path',
  'type',
  'sha',
  'size',
  'state',
  'draft',
  'status',
  'conclusion',
  'created_at',
  'updated_at',
  'closed_at',
  'merged_at',
  'started_at',
  'completed_at',
  'html_url',
  'url',
  'download_url',
  'tag_name',
  'published_at',
  'prerelease',
  'contributions',
  'login',
] as const;

const DETAIL_FIELDS = {
  user: ['login'],
  labels: ['name'],
  pull_request: ['url', 'html_url', 'merged_at'],
  author: ['name', 'date'],
  verification: ['verified', 'reason'],
} as const;

function itemSummary(value: unknown) {
  const item = record(value);
  const result = fields(item, ITEM_FIELDS);
  if (item.user) result.user = fields(item.user, DETAIL_FIELDS.user);
  if (Array.isArray(item.labels))
    result.labels = item.labels.map((label) => fields(label, DETAIL_FIELDS.labels));
  if (item.pull_request)
    result.pull_request = fields(item.pull_request, DETAIL_FIELDS.pull_request);
  if (item.commit) {
    const commit = record(item.commit);
    result.commit = {
      ...(typeof commit.message === 'string'
        ? { message: commit.message.split(/\r?\n/, 1)[0] }
        : {}),
      author: fields(commit.author, DETAIL_FIELDS.author),
      verification: fields(commit.verification, DETAIL_FIELDS.verification),
    };
  }
  return result;
}

function listEndpoint(sourceUrl: string) {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return;
  }
  if (url.origin !== 'https://api.github.com' || url.username || url.password) return;
  const endpoint = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/(.+?)\/?$/)?.[1];
  if (!endpoint) return;
  const list = /^(issues|pulls|commits|contributors|releases|tags)$/.test(endpoint);
  const wrapper = /^git\/trees\/[^/]+$/.test(endpoint)
    ? 'tree'
    : /^commits\/[^/]+\/check-runs$/.test(endpoint)
      ? 'check_runs'
      : endpoint === 'actions/workflows'
        ? 'workflows'
        : undefined;
  const contents = /^contents(?:\/.*)?$/.test(endpoint);
  return list || wrapper || contents ? { url, endpoint, wrapper, contents } : undefined;
}

/** Fixed gh/gojq projection before the existing trusted stdout bound. No user
 * expression, URL change, extra request or credential choice is introduced.
 * The same field lists drive the transport-independent summary below. */
export function githubReadProjection(sourceUrl: string): string | undefined {
  const source = listEndpoint(sourceUrl);
  if (!source) return;
  const pick = (names: readonly string[]) => `pick(${JSON.stringify(names)})`;
  const item = `. as $item | ${pick(ITEM_FIELDS)}
    | if $item.user then .user = ($item.user | ${pick(DETAIL_FIELDS.user)}) else . end
    | if ($item.labels | type) == "array" then .labels = ($item.labels | map(${pick(DETAIL_FIELDS.labels)})) else . end
    | if $item.pull_request then .pull_request = ($item.pull_request | ${pick(DETAIL_FIELDS.pull_request)}) else . end
    | if $item.commit then .commit = {
        author: ($item.commit.author | ${pick(DETAIL_FIELDS.author)}),
        verification: ($item.commit.verification | ${pick(DETAIL_FIELDS.verification)})
      } + (if ($item.commit.message | type) == "string" then {message: ($item.commit.message | split("\\n") | if length > 1 then .[0] | rtrimstr("\\r") else .[0] end)} else {} end)
      else . end`;
  const records = `if type == "array" and all(.[]; type == "object") then map(${item}) else . end`;
  const prefix =
    'def pick($keys): (if type == "object" then . else {} end) | with_entries(select(.key as $key | $keys | index($key))); ';
  if (!source.wrapper) return prefix + records;
  const key = JSON.stringify(source.wrapper);
  return (
    prefix +
    `if type == "object" and (.${source.wrapper} | type) == "array" and all(.${source.wrapper}[]; type == "object") then ${pick(['total_count', 'sha', 'truncated', source.wrapper])} | .[${key}] |= (${records}) else . end`
  );
}

/** A readable view of known GitHub list endpoints. Individual records stay intact.
 * Projection changes no URL, headers, credential scope or network permissions.
 */
export function githubReadSummary(body: string, sourceUrl: string, linkHeader?: string): string {
  const source = listEndpoint(sourceUrl);
  if (!source) return body;
  const { url, endpoint, wrapper, contents } = source;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  const records = wrapper ? record(parsed)[wrapper] : parsed;
  if (
    !Array.isArray(records) ||
    records.some((item) => item === null || typeof item !== 'object' || Array.isArray(item))
  )
    return body;
  const pagination: RecordValue = {
    page: url.searchParams.get('page') ?? '1',
    per_page: url.searchParams.get('per_page') ?? '30',
  };
  // Link values are source data, never followed automatically or treated as consent.
  for (const match of (linkHeader ?? '').matchAll(/<([^>]+)>;\s*rel="(next|prev|first|last)"/g)) {
    try {
      const destination = new URL(match[1]);
      if (destination.origin === url.origin && !destination.username && !destination.password)
        pagination[match[2]!] = destination.href;
    } catch {
      /* Malformed source metadata grants no new destination. */
    }
  }
  const issueRecords =
    endpoint === 'issues'
      ? records.filter((item) => !Object.hasOwn(item, 'pull_request')).length
      : undefined;
  return JSON.stringify({
    view: 'github-list-summary',
    source: sourceUrl,
    notice:
      'Selected fields from one list response; partial evidence, not a complete repository inventory. Bodies and verbose metadata omitted. Fetch an individual record URL for full details, or repeat this read with view: full for the entire response. Follow pagination only through the normal approved read path. Trees and contents are not paginated.',
    ...fields(parsed, ['total_count', 'sha']),
    ...(wrapper === 'tree' ? { upstream_truncated: record(parsed).truncated === true } : {}),
    returned: Math.min(records.length, 100),
    omitted: Math.max(0, records.length - 100),
    ...(issueRecords !== undefined
      ? {
          issue_count_on_page: issueRecords,
          pull_request_count_on_page: records.length - issueRecords,
        }
      : {}),
    ...(!contents && wrapper !== 'tree' ? { pagination } : {}),
    items: records.slice(0, 100).map(itemSummary),
  });
}
