import { expect, it } from 'vitest';
import { reduceCodexContract } from '../reduce-codex-contract.mjs';

const schemas = {
  requests: { oneOf: [{ properties: { method: { enum: ['item/permissions/requestApproval'] } } }] },
  notifications: {
    oneOf: ['item/started', 'item/completed'].map((method) => ({
      properties: { method: { enum: [method] } },
    })),
    definitions: { ThreadItem: { oneOf: [{ properties: { type: { enum: ['webSearch'] } } }] } },
  },
  permissions: { properties: { permissions: {}, threadId: {} } },
  lifecycle: Object.fromEntries(
    ['start', 'resume', 'fork'].map((method) => [method, { properties: { config: {} } }]),
  ),
};

it('extracts the protocol contract from the built runtime version', () => {
  expect(reduceCodexContract('0.999.0', schemas)).toMatchObject({
    codexCliVersion: '0.999.0',
    serverRequestMethods: ['item/permissions/requestApproval'],
    threadLifecycleConfig: { 'thread/start': true, 'thread/resume': true, 'thread/fork': true },
  });
});

it('rejects protocol changes requiring a new search approval policy', () => {
  const changed = structuredClone(schemas);
  changed.requests.oneOf.push({
    properties: { method: { enum: ['item/webSearch/requestApproval'] } },
  });
  expect(() => reduceCodexContract('0.999.0', changed)).toThrow('search approval');
});
