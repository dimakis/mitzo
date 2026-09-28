import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  finishCustodianRetirement,
  readCustodianRetirementReceipt,
  writeCustodianRetirementReceipt,
} from '../symposium-custodian-retirement.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'custodian-retirement-'));
  roots.push(root);
  const stateParent = join(root, 'state');
  mkdirSync(stateParent, { mode: 0o700 });
  const gatewayStateDirectory = join(stateParent, 'gateway-exact');
  mkdirSync(gatewayStateDirectory, { mode: 0o700 });
  return { stateParent, gatewayStateDirectory };
}

it('records terminal retirement only after exact runtime, host and gateway closure', async () => {
  const f = fixture();
  const calls: string[] = [];
  await finishCustodianRetirement(
    {
      begin() {
        calls.push('begin');
      },
      async retireRuntimes() {
        calls.push('retire');
      },
      async drainHost() {
        calls.push('drain');
      },
      async closeHost() {
        calls.push('close');
      },
      record() {
        calls.push('record');
        writeCustodianRetirementReceipt({
          ...f,
          instanceId: 'instance-1',
          controllerGeneration: 2,
        });
      },
    },
    new AbortController().signal,
  );
  expect(calls[0]).toBe('begin');
  expect(calls.slice(-2)).toEqual(['close', 'record']);
  expect(readCustodianRetirementReceipt(f.stateParent)).toMatchObject({
    gatewayStateDirectory: f.gatewayStateDirectory,
    instanceId: 'instance-1',
    controllerGeneration: 2,
  });
});

it.each(['retireRuntimes', 'drainHost', 'closeHost'] as const)(
  'does not record clean retirement when %s is uncertain',
  async (failure) => {
    const f = fixture();
    const record = vi.fn();
    const deps = {
      begin() {},
      async retireRuntimes() {
        if (failure === 'retireRuntimes') throw Error('uncertain');
      },
      async drainHost() {
        if (failure === 'drainHost') throw Error('uncertain');
      },
      async closeHost() {
        if (failure === 'closeHost') throw Error('uncertain');
      },
      record,
    };
    await expect(finishCustodianRetirement(deps, new AbortController().signal)).rejects.toThrow();
    expect(record).not.toHaveBeenCalled();
    expect(readCustodianRetirementReceipt(f.stateParent)).toBeNull();
  },
);

it('refuses to replace an existing receipt or record another state parent', () => {
  const f = fixture();
  const request = { ...f, instanceId: 'instance-1', controllerGeneration: 2 };
  writeCustodianRetirementReceipt(request);
  expect(() => writeCustodianRetirementReceipt(request)).toThrow();
  expect(() =>
    writeCustodianRetirementReceipt({
      ...request,
      gatewayStateDirectory: join(f.stateParent, '..', 'other'),
    }),
  ).toThrow();
});
