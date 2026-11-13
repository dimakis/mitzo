// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConversationTree } from '../ConversationTree';
import { conversationTree } from '../../lib/conversation-tree';
import type { Session } from '../../types/chat';

afterEach(cleanup);
const sessions: Session[] = [
  { id: 'lead', summary: 'PR monitoring', lastModified: 1 },
  { id: 'worker', summary: 'Architecture contract', parentConversationId: 'lead', lastModified: 1 },
  { id: 'other', summary: 'Notes', lastModified: 1 },
];
it('groups workers under their lead without hiding independent or unloaded-parent chats', () => {
  const tree = conversationTree([
    ...sessions,
    {
      id: 'child',
      summary: 'Another worker',
      parentConversationId: 'missing',
      parentConversationTitle: 'Other feature',
      lastModified: 1,
    },
  ]);
  expect(tree.map((node) => node.session.id)).toEqual(['lead', 'other', 'missing']);
  expect(tree[0].children.map((node) => node.session.id)).toEqual(['worker']);
  expect(tree[2].session.summary).toBe('Other feature');
  expect(tree[2].children[0].session.id).toBe('child');
});
it('retains every chat once if historical parent metadata contains a cycle', () => {
  const tree = conversationTree([
    { ...sessions[0], parentConversationId: 'worker' },
    sessions[1],
    sessions[2],
  ]);
  const ids = (nodes: ReturnType<typeof conversationTree>): string[] =>
    nodes.flatMap((node) => [node.session.id, ...ids(node.children)]);
  expect(ids(tree).sort()).toEqual(['lead', 'other', 'worker']);
});
it('retains the full outcome path when both lead chats are outside the loaded page', () => {
  const tree = conversationTree([
    {
      id: 'slice',
      summary: 'Architecture',
      lastModified: 1,
      parentConversationId: 'feature',
      parentConversationTitle: 'Monitoring',
      conversationAncestors: [
        { id: 'outcome', summary: 'PR delivery' },
        {
          id: 'feature',
          summary: 'Monitoring',
          parentConversationId: 'outcome',
          parentConversationTitle: 'PR delivery',
        },
      ],
    },
  ]);
  expect(tree[0].session.id).toBe('outcome');
  expect(tree[0].unloaded).toBe(true);
  expect(tree[0].children[0].session.id).toBe('feature');
  expect(tree[0].children[0].children[0].session.id).toBe('slice');
});
it('offers direct navigation, disclosure controls, current-chat indication and live status', () => {
  const select = vi.fn();
  render(<ConversationTree sessions={sessions} onSelect={select} selectedId="worker" />);
  const worker = screen.getByRole('button', { name: /Architecture contract/ });
  expect(worker.getAttribute('aria-current')).toBe('page');
  fireEvent.click(worker);
  expect(select).toHaveBeenCalledWith('worker');
  const group = screen
    .getAllByText('PR monitoring')
    .map((el) => el.closest('summary'))
    .find(Boolean)!;
  expect(group.getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(group);
  expect(group.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(group);
  expect(group.getAttribute('aria-expanded')).toBe('true');
});
it('nests outcome, feature lead and slice worker while preserving each chat runtime', () => {
  const select = vi.fn();
  const mixed: Session[] = [
    {
      id: 'outcome',
      summary: 'PR delivery',
      lastModified: 1,
      agentName: 'Coordinator',
      engine: 'claude-sdk',
      executionLocation: 'local',
      workRole: { itemId: 'o', level: 'outcome', role: 'lead', assignment: 'current' },
    },
    {
      id: 'feature',
      summary: 'PR monitoring',
      lastModified: 1,
      parentConversationId: 'outcome',
      agentName: 'Developer',
      engine: 'codex',
      executionLocation: 'openshell',
      workRole: { itemId: 'f', level: 'feature', role: 'lead', assignment: 'current' },
    },
    {
      id: 'slice',
      summary: 'Runtime contract',
      lastModified: 1,
      parentConversationId: 'feature',
      agentName: 'Architect',
      engine: 'responses',
      executionLocation: 'local',
      workRole: { itemId: 's', level: 'slice', role: 'worker', assignment: 'current' },
    },
  ];
  const tree = conversationTree(mixed);
  expect(tree[0].children[0].children[0].session.id).toBe('slice');
  render(<ConversationTree sessions={mixed} selectedId="slice" onSelect={select} />);
  expect(screen.getByText(/Outcome orchestrator/)).toBeTruthy();
  expect(screen.getByText(/Feature lead/)).toBeTruthy();
  expect(screen.getByText(/Slice worker/)).toBeTruthy();
  expect(screen.getByText(/Developer · Codex · OpenShell/)).toBeTruthy();
  expect(screen.getByText(/Architect · Responses · Local Mac/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Runtime contract/ }));
  expect(select).toHaveBeenCalledWith('slice');
});
