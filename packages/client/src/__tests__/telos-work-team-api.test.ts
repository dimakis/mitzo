import { describe, expect, it, vi } from 'vitest';
import { TelosWorkApiClient } from '../telos-work-api.js';

const team = { itemId: 'item', revision: 'a'.repeat(64), members: [] };
const input = {
  operation: 'link' as const,
  itemId: 'item',
  requestId: 'original-request',
  expectedRevision: team.revision,
  conversationId: 'chat',
  displayName: 'Chat',
  role: 'reviewer' as const,
  responsibility: 'Review',
  reportsToMembershipId: null,
};
const receipt = {
  requestId: input.requestId,
  commandId: '113fa14b-4a14-4f5a-bf9b-df13a78c165b',
  actorId: 'operator:fixture',
  team,
};
describe('Telos team client', () => {
  it('uses exact identities and signals without retrying an uncertain response', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(team)))
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt)))
      .mockRejectedValueOnce(new TypeError('lost reply'));
    const api = new TelosWorkApiClient(fetch);
    const signal = new AbortController().signal;
    expect(await api.readTeam('item', signal)).toEqual(team);
    expect(await api.teamCommand(input, signal)).toEqual(receipt);
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/telos/work/team/commands',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        signal,
      }),
    );
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(input);
    await expect(api.teamCommand(input)).rejects.toThrow('lost reply');
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('rejects substituted items and request identities instead of reporting another command as success', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...team, itemId: 'foreign' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...receipt, requestId: 'foreign' })));
    const api = new TelosWorkApiClient(fetch);
    await expect(api.readTeam('item')).rejects.toMatchObject({ status: 502, code: 'invalid' });
    await expect(api.teamCommand(input)).rejects.toMatchObject({ status: 502, code: 'invalid' });
  });
});
