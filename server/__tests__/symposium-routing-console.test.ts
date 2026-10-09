import { expect, it } from 'vitest';
import { projectRoutingConsole } from '../symposium-routing-console.js';
const timestamp = '2026-10-09T16:27:28.310Z';
const line = (ordinal = 1, status = 403) =>
  `${timestamp} DEBUG openshell.routing_http: routing diagnostic v1 kind=account_check method=GET outcome=response request_ordinal=${ordinal} status_code=${status}`;
it('projects only exact finite dedicated messages with native timestamps', () => {
  expect(projectRoutingConsole(line())).toEqual({
    source: 'owned-supervisor-console-v1',
    availability: 'captured',
    observations: [
      {
        kind: 'account_check',
        method: 'GET',
        outcome: 'response',
        requestOrdinal: 1,
        statusCode: 403,
        recordedAt: timestamp,
      },
    ],
  });
});
it('strips unrelated/private lines without exposing raw errors', () => {
  const result = projectRoutingConsole(
    `PRIVATE Authorization: Bearer token\n${line()}\nINFO other: private-body`,
  );
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|private|token|Authorization/);
  expect(result.observations).toHaveLength(1);
});
it.each([
  `${line()} body=PRIVATE`,
  line().replace('method=GET', 'method=POST'),
  line().replace('kind=account_check', 'kind=other'),
  line().replace('403', '600'),
  line(0),
  line(Number.MAX_SAFE_INTEGER + 1),
  line().replace(timestamp, 'invalid'),
  line().replace('DEBUG', 'INFO'),
  line().replace('openshell.routing_http:', 'other:'),
])('rejects noncontract message %s', (text) => {
  expect(projectRoutingConsole(text).availability).toBe('unavailable');
});
it('keeps multiple exact endpoint attempts distinct without inferring one cause', () => {
  const result = projectRoutingConsole(`${line(1, 401)}\n${line(2, 200)}`);
  expect(result.observations.map((x) => x.statusCode)).toEqual([401, 200]);
});
it('fails closed for duplicate ordinals, overflow and oversized console', () => {
  for (const input of [
    `${line()}\n${line()}`,
    Array.from({ length: 33 }, (_, i) => line(i + 1)).join('\n'),
    'x'.repeat(131073),
  ])
    expect(projectRoutingConsole(input).availability).toBe('unavailable');
});
it('projects only finite actually emitted failures without fabricated status', () => {
  const value = line()
    .replace('outcome=response', 'outcome=transport_failed')
    .replace(' status_code=403', '');
  expect(projectRoutingConsole(value).observations[0]).toMatchObject({
    outcome: 'transport_failed',
  });
  expect(projectRoutingConsole(value).observations[0]).not.toHaveProperty('statusCode');
  expect(projectRoutingConsole(value.replace('transport_failed', 'tls_failed')).availability).toBe(
    'unavailable',
  );
});
