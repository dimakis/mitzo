import { expect, it } from 'vitest';
import { RoutingDiagnosticResultSchema } from '../symposium-model-discovery.js';

it('accepts only a bounded finite routing observation with no catalog publication', () => {
  const value = {
    status: 'failed',
    inference: false,
    catalogPublication: false,
    networkObservation: {
      source: 'owned-supervisor-console-v1',
      availability: 'captured',
      observations: [
        {
          kind: 'account_check',
          method: 'GET',
          requestOrdinal: 1,
          outcome: 'response',
          statusCode: 403,
          recordedAt: '2026-10-09T16:27:28.310Z',
        },
      ],
    },
  };
  expect(RoutingDiagnosticResultSchema.parse(value)).toEqual(value);
});

it.each(['headers', 'body', 'error', 'token', 'provider'])(
  'rejects arbitrary %s result fields',
  (field) => {
    expect(
      RoutingDiagnosticResultSchema.safeParse({
        status: 'complete',
        inference: false,
        catalogPublication: false,
        [field]: 'private-value',
      }).success,
    ).toBe(false);
  },
);

it('rejects unknown categories, raw network fields, malformed statuses and response/failure contradictions', () => {
  const row = {
    kind: 'account_check',
    method: 'GET',
    requestOrdinal: 1,
    outcome: 'response',
    statusCode: 403,
    recordedAt: '2026-10-09T16:27:28.310Z',
  };
  for (const patch of [
    { method: 'POST' },
    { outcome: 'raw-private-error' },
    { statusCode: 700 },
    { headers: 'private-token' },
    { outcome: 'transport_failed', statusCode: 200 },
    { requestOrdinal: 0 },
  ]) {
    const value = {
      status: 'failed',
      inference: false,
      catalogPublication: false,
      networkObservation: {
        source: 'owned-supervisor-console-v1',
        availability: 'captured',
        observations: [{ ...row, ...patch }],
      },
    };
    expect(RoutingDiagnosticResultSchema.safeParse(value).success).toBe(false);
  }
});

it('rejects unbounded observations and unavailable snapshots claiming captured HTTP evidence', () => {
  const row = {
    kind: 'account_check',
    method: 'GET',
    requestOrdinal: 1,
    outcome: 'response',
    statusCode: 403,
    recordedAt: '2026-10-09T16:27:28.310Z',
  };
  for (const networkObservation of [
    {
      source: 'owned-supervisor-console-v1',
      availability: 'captured',
      observations: Array(33).fill(row),
    },
    { source: 'owned-supervisor-console-v1', availability: 'unavailable', observations: [row] },
  ])
    expect(
      RoutingDiagnosticResultSchema.safeParse({
        status: 'failed',
        inference: false,
        catalogPublication: false,
        networkObservation,
      }).success,
    ).toBe(false);
});
