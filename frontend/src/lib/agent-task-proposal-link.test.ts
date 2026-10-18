import { expect, it } from 'vitest';
import { agentTaskProposalLink, parseAgentTaskProposalLocation } from './agent-task-proposal-link';
const receipt = {
  proposalId: 'proposal-one',
  status: 'awaiting_user_review',
  taskId: 'daily',
  expectedRevision: 3,
};
const block = {
  blockId: 'block',
  blockType: 'tool_use' as const,
  content: '',
  toolName: 'AgentProposeTask',
  toolId: 'public-id-not-provider-id',
  toolResult: JSON.stringify(receipt),
};
it('builds a read-only Library pointer from the actual successful task tool block and session', () => {
  const link = agentTaskProposalLink(block, 'chat/one')!;
  expect(link.identity).toEqual({
    proposalId: 'proposal-one',
    sessionId: 'chat/one',
    taskId: 'daily',
    expectedRevision: 3,
  });
  const url = new URL(link.url, 'http://fixture');
  expect(url.pathname).toBe('/agent-library');
  expect(parseAgentTaskProposalLocation(url.searchParams)).toEqual(link.identity);
  expect(link.url).not.toContain('public-id-not-provider-id');
});
it('does not turn arbitrary JSON, error output, aliases or incomplete receipts into review links', () => {
  for (const value of [
    { ...block, toolName: 'Bash' },
    { ...block, toolName: 'mcp__mitzo-connections__AgentProposeTask' },
    { ...block, blockType: 'text' as const },
    { ...block, toolError: true },
    { ...block, toolResult: 'not JSON' },
    { ...block, toolResult: JSON.stringify({ ...receipt, owner: 'forged' }) },
    { ...block, toolResult: JSON.stringify({ ...receipt, status: 'saved' }) },
    { ...block, toolResult: JSON.stringify({ ...receipt, expectedRevision: -1 }) },
  ])
    expect(agentTaskProposalLink(value, 'chat')).toBeNull();
  expect(agentTaskProposalLink(block)).toBeNull();
  expect(agentTaskProposalLink({ ...block, toolResult: undefined }, 'chat')).toBeNull();
});
it('rejects missing, duplicate, malformed and unsafe location identities', () => {
  for (const query of [
    'proposal=p&session=s&task=t',
    'proposal=p&session=s&task=t&revision=-1',
    'proposal=p&session=s&task=t&revision=1.5',
    'proposal=p&session=s&task=t&revision=9007199254740992',
    'proposal=p&session=s&task=t&revision=0&proposal=other',
    'proposal=p&session=s&task=t&revision=0&session=other',
    'proposal=p&session=s&task=t&revision=0&task=other',
    'proposal=p&session=s&task=t&revision=0&revision=1',
  ])
    expect(parseAgentTaskProposalLocation(new URLSearchParams(query))).toBeNull();
});
