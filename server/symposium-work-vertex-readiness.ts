const KEY = 'GOOGLE_VERTEX_AI_TOKEN';
const HEADER = [
  'PROVIDER',
  'CREDENTIAL_KEY',
  'STRATEGY',
  'STATUS',
  'RECOVERY',
  'EXPIRES_AT',
  'NEXT_REFRESH',
  'LAST_REFRESH',
  'FAILURE_CODE',
  'LAST_ERROR',
];
const MARGIN_MS = 60_000;
const OBSERVATION_MS = 10_000;
function requireValue(value: unknown): asserts value {
  if (!value) throw Error();
}
function timestamp(value: string) {
  requireValue(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value));
  const result = Date.parse(value.replace(' ', 'T') + 'Z');
  requireValue(
    Number.isSafeInteger(result) &&
      new Date(result).toISOString().slice(0, 19).replace('T', ' ') === value,
  );
  return result;
}
/** Current gateway credential readiness, not IAM/inference or sandbox-installation proof.
 * CLI contract pinned to upstream 854b2370b: refresh status is table-only; list
 * is secret-free JSON. Status `refreshed` precedes applying the credential, so
 * require matching installed provider expiry and a stable census around it.
 * No ready boolean, timestamps or credential material come from the caller.
 */
export function assertSymposiumWorkVertexReadiness(input: {
  provider: string;
  providerId: string;
  workspace: string;
  invoke(args: string[], timeoutMs: number): string;
}): void {
  try {
    const started = performance.now(),
      wallStarted = Date.now();
    const invoke = (args: string[]) => {
      const remaining = Math.floor(OBSERVATION_MS - (performance.now() - started));
      requireValue(remaining > 0);
      const output = input.invoke(args, remaining);
      requireValue(
        typeof output === 'string' &&
          Buffer.byteLength(output) <= 1_000_000 &&
          performance.now() - started < OBSERVATION_MS,
      );
      return output;
    };
    const census = () => {
      let token = '';
      const seen = new Set<string>();
      const matches: Record<string, unknown>[] = [];
      for (let page = 0; page < 10; page++) {
        const value = JSON.parse(
          invoke([
            'list',
            '--output',
            'json',
            '--page-size',
            '100',
            ...(token ? ['--page-token', token] : []),
          ]),
        );
        requireValue(
          Array.isArray(value.providers) &&
            value.providers.length <= 100 &&
            typeof value.next_page_token === 'string' &&
            value.next_page_token.length <= 4096,
        );
        for (const row of value.providers) {
          requireValue(row && typeof row === 'object');
          if (row.name === input.provider) matches.push(row);
        }
        token = value.next_page_token;
        if (!token) break;
        requireValue(!seen.has(token) && page < 9);
        seen.add(token);
      }
      requireValue(matches.length === 1);
      const row = matches[0],
        expirations = row.credential_expires_at_ms as Record<string, unknown> | undefined;
      const expiry = expirations?.[KEY];
      requireValue(
        row.id === input.providerId &&
          row.workspace === input.workspace &&
          row.type === 'google-vertex-ai',
      );
      requireValue(
        Number.isSafeInteger(row.resource_version) && (row.resource_version as number) > 0,
      );
      requireValue(Array.isArray(row.credential_keys) && row.credential_keys.includes(KEY));
      requireValue(Number.isSafeInteger(expiry) && (expiry as number) > 0);
      return { revision: row.resource_version, expiry: expiry as number };
    };
    const before = census();
    const lines = invoke(['refresh', 'status', input.provider, '--credential-key', KEY])
      .trim()
      .split(/\r?\n/);
    requireValue(
      lines.length === 2 &&
        JSON.stringify(lines[0].trim().split(/ {2,}/)) === JSON.stringify(HEADER),
    );
    // Empty failure/error columns trim away. Any nonempty diagnostic rejects,
    // and is never included in public errors or retained receipts.
    const fields = lines[1].trim().split(/ {2,}/);
    requireValue(
      fields.length === 8 &&
        fields[0] === input.provider &&
        fields[1] === KEY &&
        fields[2] === 'oauth2_refresh_token' &&
        fields[3] === 'refreshed' &&
        fields[4] === '-',
    );
    const expiry = timestamp(fields[5]),
      next = timestamp(fields[6]),
      last = timestamp(fields[7]);
    const after = census(),
      now = Date.now();
    requireValue(now >= wallStarted && now - wallStarted < OBSERVATION_MS);
    requireValue(
      before.revision === after.revision &&
        before.expiry === after.expiry &&
        expiry === Math.floor(after.expiry / 1000) * 1000,
    );
    requireValue(
      last > 0 && last <= now && next > last && next <= expiry && after.expiry - now > MARGIN_MS,
    );
  } catch {
    throw new Error('Vertex credential readiness unavailable');
  }
}
