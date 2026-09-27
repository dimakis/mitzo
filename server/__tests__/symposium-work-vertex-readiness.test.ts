import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertSymposiumWorkVertexReadiness } from '../symposium-work-vertex-readiness.js';
const now = Date.UTC(2026, 8, 27, 12);
const expires = now + 3600_000;
const date = (n: number) => new Date(n).toISOString().slice(0, 19).replace('T', ' ');
const header =
  'PROVIDER  CREDENTIAL_KEY  STRATEGY  STATUS  RECOVERY  EXPIRES_AT  NEXT_REFRESH  LAST_REFRESH  FAILURE_CODE  LAST_ERROR';
const provider = 'symposium-vertex-0123456789abcdef01234567';
const expected = { provider, providerId: 'provider-id', workspace: 'work' };
const row = {
  id: expected.providerId,
  name: provider,
  workspace: 'work',
  type: 'google-vertex-ai',
  resource_version: 2,
  credential_keys: ['GOOGLE_VERTEX_AI_TOKEN'],
  credential_expires_at_ms: { GOOGLE_VERTEX_AI_TOKEN: expires },
};
const census = (r: unknown = row) => JSON.stringify({ providers: [r], next_page_token: '' });
const status = (state = 'refreshed', expiry = expires) =>
  header +
  '\n' +
  [
    provider,
    'GOOGLE_VERTEX_AI_TOKEN',
    'oauth2_refresh_token',
    state,
    '-',
    date(expiry),
    date(expires - 300000),
    date(now - 10000),
    '',
    '',
  ].join('  ') +
  '\n';
function run(outputs = [census(), status(), census()]) {
  const invoke = vi.fn((_args: string[], _timeout: number) => outputs.shift()!);
  assertSymposiumWorkVertexReadiness({ ...expected, invoke });
  return invoke;
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('owned Vertex current refresh readiness', () => {
  it('reads exact supported commands with bounded timeout and stable installed expiry', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const invoke = run();
    expect(invoke.mock.calls.map((c) => c[0])).toEqual([
      ['list', '--output', 'json', '--page-size', '100'],
      ['refresh', 'status', provider, '--credential-key', 'GOOGLE_VERTEX_AI_TOKEN'],
      ['list', '--output', 'json', '--page-size', '100'],
    ]);
    expect(invoke.mock.calls.every((c) => c[1] > 0 && c[1] <= 10000)).toBe(true);
  });
  it.each(['configured', 'refreshing', 'error', 'ready'])('denies status %s', (state) => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(() => run([census(), status(state), census()])).toThrow(
      'Vertex credential readiness unavailable',
    );
  });
  it('denies absent expiry, replaced provider, changed revision and mismatched expiry', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    for (const changed of [
      { ...row, credential_expires_at_ms: {} },
      { ...row, id: 'replacement' },
      { ...row, resource_version: 3 },
      { ...row, credential_expires_at_ms: { GOOGLE_VERTEX_AI_TOKEN: expires + 1000 } },
    ])
      expect(() => run([census(), status(), census(changed)])).toThrow();
  });
  it('denies duplicate rows, error prose and malformed dates without leaking it', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    for (const table of [
      status() + status().split('\n')[1],
      status().trim() + '  secret-error',
      status().replace('2026-09-27', '2026-02-31'),
    ])
      expect(() => run([census(), table, census()])).toThrow(
        'Vertex credential readiness unavailable',
      );
  });
  it('requires a fresh lifetime margin at final observation', () => {
    vi.spyOn(Date, 'now').mockReturnValue(expires - 59000);
    expect(() => run()).toThrow();
  });
  it('rejects changing pages or invocation errors safely', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(() =>
      run([
        JSON.stringify({ providers: [], next_page_token: 'repeat' }),
        JSON.stringify({ providers: [], next_page_token: 'repeat' }),
      ]),
    ).toThrow();
    expect(() =>
      assertSymposiumWorkVertexReadiness({
        ...expected,
        invoke() {
          throw Error('secret-token');
        },
      }),
    ).toThrow('Vertex credential readiness unavailable');
  });
  it('rejects a late subprocess result rather than admitting after its deadline', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    expect(() =>
      assertSymposiumWorkVertexReadiness({
        ...expected,
        invoke() {
          elapsed = 10001;
          return census();
        },
      }),
    ).toThrow('Vertex credential readiness unavailable');
  });
  it('rejects wall-clock reversal and renewed expiry without matching refresh proof', () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(now)
      .mockReturnValue(now - 1);
    expect(() => run()).toThrow();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(() => run([census(), status('refreshed', expires + 1000), census()])).toThrow();
  });
  it('preserves rendered-second precision for installed millisecond expiry', () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const precise = { ...row, credential_expires_at_ms: { GOOGLE_VERTEX_AI_TOKEN: expires + 999 } };
    expect(() => run([census(precise), status(), census(precise)])).not.toThrow();
  });
});
