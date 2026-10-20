import { afterEach, describe, expect, it, vi } from 'vitest';
import * as protocol from '@mitzo/protocol';
import { prepareLocalFirstCommand } from '../explicit-local-chat';
import { createChatRuntimeSelection } from '../chat-runtime-selection';
import { ordinaryRuntimeInventoryFixture } from '../../test-utils/ordinary-runtime-inventory-fixture';

afterEach(() => vi.restoreAllMocks());

describe.each(['local', 'openshell'] as const)(
  'actual ordinary %s fresh permission provenance',
  (location) => {
    it.each(['ask', 'agent', 'auto'] as const)(
      'uses the shared constructor for explicit %s selection',
      (mode) => {
        const inventory = ordinaryRuntimeInventoryFixture();
        const selection = {
          ...createChatRuntimeSelection(),
          execution: { location, targetId: location === 'local' ? 'mac' : 'sandbox' },
          capabilityRevision: inventory.capabilityRevision,
          account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' },
          agentProfile: { profileId: 'agent', revision: 1 },
        };
        const input = {
          clientMsgId: 'explicit-first-command',
          repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
          mode,
          text: 'Inspect',
        };
        const before = structuredClone({ selection, inventory, input });
        const constructor = vi.spyOn(protocol, 'createOrdinaryFreshPermission');
        const result = prepareLocalFirstCommand(selection, inventory, input);
        expect(result.reason).toBeUndefined();
        expect(result.request?.selection.permission).toStrictEqual({ mode, revision: 0 });
        expect(result.request?.runtime.mode).toBe(mode);
        expect(result.request?.runOn).toBe(location);
        expect(result.request?.clientMsgId).toBe(input.clientMsgId);
        expect(result.request?.repositoryWorkspaceId).toBe(input.repositoryWorkspaceId);
        expect(constructor).toHaveBeenCalledTimes(1);
        expect(constructor).toHaveBeenCalledWith(mode);
        expect({ selection, inventory, input }).toEqual(before);
      },
    );
  },
);
