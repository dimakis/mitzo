import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type Contract = {
  codexCliVersion: string;
  serverRequestMethods: string[];
  permissionsApprovalFields: string[];
  threadLifecycleConfig: Record<string, boolean>;
  webSearchObservation: {
    itemType: string;
    notifications: string[];
    preExecutionApprovalMethod: string | null;
  };
};

const fixture = fileURLToPath(
  new URL(
    '../../docs/spikes/codex-web-search-policy/app-server-contract-0.153.4.json',
    import.meta.url,
  ),
);
const contract = JSON.parse(readFileSync(fixture, 'utf8')) as Contract;

describe('pinned Codex native web-search contract', () => {
  it('records the CLI version deployed by Mitzo', () => {
    expect(contract.codexCliVersion).toBe('0.153.4');
  });

  it('has no pre-execution native web-search approval callback', () => {
    expect(contract.webSearchObservation).toMatchObject({
      itemType: 'webSearch',
      notifications: ['item/started', 'item/completed'],
      preExecutionApprovalMethod: null,
    });
    expect(
      contract.serverRequestMethods.filter(
        (method) => /search/i.test(method) && /approval|requestUserInput/i.test(method),
      ),
    ).toEqual([]);
  });

  it('does not mistake generic permission escalation for search consent', () => {
    expect(contract.serverRequestMethods).toContain('item/permissions/requestApproval');
    expect(
      contract.permissionsApprovalFields.filter((field) =>
        ['query', 'queries', 'url', 'urls', 'search'].includes(field),
      ),
    ).toEqual([]);
  });

  it('supports resolved configuration at every safe thread boundary', () => {
    expect(contract.threadLifecycleConfig).toEqual({
      'thread/start': true,
      'thread/resume': true,
      'thread/fork': true,
    });
  });
});
