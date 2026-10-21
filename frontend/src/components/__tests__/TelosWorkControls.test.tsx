// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TelosWorkApiClient } from '@mitzo/client';
import {
  TelosWorkViewSchema,
  TelosWorkControlViewSchema,
  type TelosWorkControlView,
} from '@mitzo/protocol';
import { createTelosWorkFixtures } from '../../test-utils/telos-work-fixtures';
import { TelosWorkControls } from '../TelosWorkControls';
import { TelosChatFrame } from '../TelosChatFrame';

const inventory = vi.hoisted(() => ({ items: [] as Array<{ id: string; children: unknown[] }> }));
vi.mock('../../hooks/useTodoData', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useTodoData')>()),
  useTodoData: () => ({ items: inventory.items, loading: false, error: null, refresh: vi.fn() }),
}));
const source = createTelosWorkFixtures().homeStudio.items[0];
const coordinator = {
  ...source,
  itemId: 'coordinator',
  parentId: null,
  kind: 'coordinator' as const,
  summary: 'Feature programme',
};
const outcomes = Array.from({ length: 6 }, (_, i) => ({
  ...source,
  itemId: `outcome-${i}`,
  parentId: 'coordinator',
  summary: `Feature ${i}`,
}));
const unrelated = { ...source, itemId: 'job', parentId: null, summary: 'Unrelated Job' };
const workers = outcomes.slice(1).map((r, i) => ({
  ...source,
  itemId: `worker-${i}`,
  parentId: r.itemId,
  kind: 'work_item' as const,
  summary: `Worker ${i}`,
}));
const records = [coordinator, ...outcomes, unrelated, ...workers];
function work(
  kind: 'coordinator' | 'outcome' | 'work_item' = 'coordinator',
  id = 'coordinator',
  conversationId = 'coordinator-chat',
) {
  return TelosWorkViewSchema.parse({
    itemId: id,
    kind,
    parentId: null,
    revision: 'a'.repeat(64),
    sources: [],
    attempts: [],
    links: [],
    assignments: [
      {
        itemId: id,
        role: kind === 'work_item' ? 'worker' : 'lead',
        conversation: { namespace: 'mitzo', conversationId },
        revision: 1,
        assignedAt: null,
        assignedBy: null,
      },
    ],
  });
}
function receipt(
  stage: TelosWorkControlView['stage'] = 'requested',
  scope: TelosWorkControlView['scope'] = 'new_worker_dispatch',
): TelosWorkControlView {
  return {
    version: 1,
    controlId: 'control',
    coordinatorItemId: 'coordinator',
    coordinatorConversationId: 'coordinator-chat',
    priorityItemId: 'outcome-0',
    scope,
    stage,
    publicationRevalidation:
      stage === 'released' && scope === 'publication' ? 'required' : 'not_applicable',
    targets: outcomes.slice(1).map((r, i) => ({
      itemId: r.itemId,
      leadConversationId: `lead-${i}`,
      assignmentRevision: 1,
      stage: stage === 'released' ? 'applied' : stage,
      workers: [
        {
          itemId: `worker-${i}`,
          conversationId: `native-${i}`,
          assignmentRevision: 1,
          stage: stage === 'acknowledged' ? 'requested' : stage === 'released' ? 'applied' : stage,
        },
      ],
    })),
    history: [],
  };
}
const data = {
  itemId: 'coordinator',
  record: coordinator,
  work: work(),
  workCurrent: true,
  refreshKey: '0',
};
beforeEach(() => {
  sessionStorage.clear();
  function node(record: (typeof records)[number]): { id: string; children: unknown[] } {
    return {
      id: record.itemId,
      children: records.filter((value) => value.parentId === record.itemId).map(node),
    };
  }
  inventory.items = records.filter((value) => !value.parentId).map(node);
  vi.spyOn(TelosWorkApiClient.prototype, 'readRecord').mockImplementation(async (id) =>
    records.find((r) => r.itemId === id)!,
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('requests the exact five attached other leads after explicit priority/scope selection; numeric priority and unrelated Job are not control targets', async () => {
  let stored: TelosWorkControlView[] = [];
  const control = vi
    .spyOn(TelosWorkApiClient.prototype, 'control')
    .mockImplementation(async (c) => {
      if (c.operation === 'inbox') return stored;
      if (c.operation === 'request') {
        stored = [receipt()];
        return stored[0];
      }
      return stored[0];
    });
  render(<TelosWorkControls data={data} conversationId="coordinator-chat" />);
  await screen.findByRole('button', { name: 'Feature 0' });
  expect(control.mock.calls.map(([c]) => c.operation)).toEqual(['inbox']);
  fireEvent.click(screen.getByRole('button', { name: 'Feature 0' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Hold scope' }), {
    target: { value: 'new_worker_dispatch' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send hold to five leads' }));
  await screen.findByText('Hold requested · acknowledgements pending');
  const command = control.mock.calls.map(([c]) => c).find((c) => c.operation === 'request')!;
  expect(command).toEqual({
    operation: 'request',
    requestId: expect.any(String),
    coordinatorItemId: 'coordinator',
    priorityItemId: 'outcome-0',
    targetItemIds: outcomes.slice(1).map((r) => r.itemId),
    scope: 'new_worker_dispatch',
  });
  expect(command).not.toHaveProperty('actor');
  expect(command).not.toHaveProperty('assignmentRevision');
  expect(control.mock.calls.map(([c]) => c.operation)).not.toContain('acknowledge');
});
it('Check acknowledgements reads backend-native stages and release remains distinct from publication validation', async () => {
  let current = receipt('requested', 'publication');
  const control = vi
    .spyOn(TelosWorkApiClient.prototype, 'control')
    .mockImplementation(async (c) => {
      if (c.operation === 'inbox') return [current];
      if (c.operation === 'release') {
        current = receipt('released', 'publication');
        return current;
      }
      return current;
    });
  render(<TelosWorkControls data={data} conversationId="coordinator-chat" />);
  await screen.findByText('Hold requested · acknowledgements pending');
  current = receipt('acknowledged', 'publication');
  fireEvent.click(screen.getByRole('button', { name: 'Check acknowledgements' }));
  await screen.findByText('Acknowledged · application pending');
  expect(screen.queryByText('Hold applied')).toBeNull();
  current = receipt('applied', 'publication');
  fireEvent.click(screen.getByRole('button', { name: 'Check acknowledgements' }));
  await screen.findByText('Hold applied');
  fireEvent.click(screen.getByRole('button', { name: 'Release held leads' }));
  await screen.findByText('Hold released · revalidation required');
  expect(screen.getByText(/Current-main revalidation is required/)).toBeTruthy();
  expect(screen.queryByText(/Publication granted|Revalidation complete/)).toBeNull();
  expect(control.mock.calls.map(([c]) => c.operation).filter((x) => x !== 'inbox')).toEqual([
    'read',
    'read',
    'release',
  ]);
});
it('keeps missing current recipients pending and scopes a worker card to that worker rather than its sibling receipts', async () => {
  const value = receipt();
  value.targets[0].workers[0].conversationId = null;
  vi.spyOn(TelosWorkApiClient.prototype, 'control').mockResolvedValue([value]);
  const child = {
    itemId: 'worker-0',
    record: workers[0],
    work: work('work_item', 'worker-0', 'native-0'),
    workCurrent: true,
    refreshKey: '0',
  };
  render(<TelosWorkControls data={child} conversationId="native-0" />);
  await screen.findByText('Hold requested · acknowledgements pending');
  expect(screen.getByText(/Current recipient unavailable/)).toBeTruthy();
  expect(screen.queryByText('Worker 1')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Release held leads' })).toBeNull();
  expect(screen.queryByRole('combobox', { name: 'Hold scope' })).toBeNull();
});
it('does not turn additional or retired coordinator chats into the current coordinator operator surface', () => {
  const control = vi.spyOn(TelosWorkApiClient.prototype, 'control');
  render(<TelosWorkControls data={data} conversationId="additional-chat" />);
  expect(screen.queryByText(/Which outcome is highest priority/)).toBeNull();
  expect(control).not.toHaveBeenCalled();
});
it('opens the existing frame work tree from the receipt surface without replacing its draft or header', async () => {
  vi.spyOn(TelosWorkApiClient.prototype, 'control').mockResolvedValue([]);
  render(
    <TelosChatFrame
      conversationId="coordinator-chat"
      itemTitle="Feature programme"
      chatCount={1}
      onItem={vi.fn()}
      onChats={vi.fn()}
      header={<h1>Ordinary coordinator chat</h1>}
      tree={<p>Canonical work tree</p>}
    >
      <textarea aria-label="Message Mitzo" defaultValue="Unsent coordinator draft" />
      <TelosWorkControls data={data} conversationId="coordinator-chat" />
    </TelosChatFrame>,
  );
  const draft = screen.getByRole('textbox', { name: 'Message Mitzo' });
  fireEvent.click(await screen.findByRole('button', { name: 'Inspect work tree' }));
  expect(screen.getByRole('region', { name: 'Work tree' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Close work tree' }));
  expect(screen.getByRole('textbox', { name: 'Message Mitzo' })).toBe(draft);
  expect((draft as HTMLTextAreaElement).value).toBe('Unsent coordinator draft');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Toggle work tree' }));
});

it('keeps an unavailable attached scope disabled and retries its canonical reads explicitly before enabling a request', async () => {
  let unavailable = true;
  vi.spyOn(TelosWorkApiClient.prototype, 'readRecord').mockImplementation(async (id) => {
    if (unavailable && id === 'outcome-5') throw Error('Unavailable');
    return records.find((value) => value.itemId === id)!;
  });
  const control = vi.spyOn(TelosWorkApiClient.prototype, 'control').mockResolvedValue([]);
  render(<TelosWorkControls data={data} conversationId="coordinator-chat" />);
  await screen.findByText('Attached outcome scope unavailable. Refresh before sending a hold.');
  expect((screen.getByRole('button', { name: /Send hold to/ }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(control.mock.calls.every(([command]) => command.operation === 'inbox')).toBe(true);
  unavailable = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry attached outcomes' }));
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Feature 5' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Feature 0' }));
  expect(
    (screen.getByRole('button', { name: 'Send hold to five leads' }) as HTMLButtonElement).disabled,
  ).toBe(false);
  expect(control.mock.calls.every(([command]) => command.operation === 'inbox')).toBe(true);
});
it('retains a released receipt while allowing an explicit new hold with a new priority and scope', async () => {
  const control = vi
    .spyOn(TelosWorkApiClient.prototype, 'control')
    .mockResolvedValue([receipt('released')]);
  render(<TelosWorkControls data={data} conversationId="coordinator-chat" />);
  await screen.findByRole('heading', { name: 'Hold released' });
  fireEvent.click(screen.getByRole('button', { name: 'Feature 1' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Hold scope' }), {
    target: { value: 'safe_point' },
  });
  expect(
    (screen.getByRole('button', { name: 'Send hold to five leads' }) as HTMLButtonElement).disabled,
  ).toBe(false);
  expect(screen.getByRole('heading', { name: 'Hold released' })).toBeTruthy();
  expect(control.mock.calls.every(([command]) => command.operation === 'inbox')).toBe(true);
});

it('requests the exact attached scope when an unrelated Job record is unavailable and never reads that record', async () => {
  const read = vi
    .spyOn(TelosWorkApiClient.prototype, 'readRecord')
    .mockImplementation(async (id) => {
      if (id === 'job') throw Error('Unrelated Job record unavailable');
      return records.find((value) => value.itemId === id)!;
    });
  const control = vi
    .spyOn(TelosWorkApiClient.prototype, 'control')
    .mockImplementation(async (command) => (command.operation === 'inbox' ? [] : receipt()));
  render(<TelosWorkControls data={data} conversationId="coordinator-chat" />);
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Feature 0' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  expect(read.mock.calls.some(([id]) => id === 'job')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Feature 0' }));
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Send hold to five leads' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Send hold to five leads' }));
  await waitFor(() =>
    expect(control.mock.calls.find(([command]) => command.operation === 'request')?.[0]).toEqual({
      operation: 'request',
      requestId: expect.any(String),
      coordinatorItemId: 'coordinator',
      priorityItemId: 'outcome-0',
      targetItemIds: outcomes.slice(1).map((value) => value.itemId),
      scope: 'publication',
    }),
  );
});

it.each(['requested', 'acknowledged', 'applied', 'released'] as const)(
  'renders an actual operator-origin %s receipt without inventing priority or issuing a null record read',
  async (stage) => {
    const operator = TelosWorkControlViewSchema.parse({
      ...receipt(stage, 'publication'),
      origin: 'operator_pause',
      coordinatorConversationId: null,
      priorityItemId: null,
    });
    const control = vi.spyOn(TelosWorkApiClient.prototype, 'control').mockResolvedValue([operator]);
    render(<TelosWorkControls data={data} conversationId="coordinator-chat" />);
    const card = await screen.findByRole('article', {
      name: 'Operator pause receipt: Publishing to shared main',
    });
    expect(card.textContent).toContain('Requested by operator');
    expect(card.textContent).not.toContain('Highest priority');
    expect(card.textContent).not.toContain('Work title unavailable');
    expect(TelosWorkApiClient.prototype.readRecord).not.toHaveBeenCalledWith(
      null,
      expect.anything(),
    );
    expect(TelosWorkApiClient.prototype.readRecord).not.toHaveBeenCalledWith(
      'null',
      expect.anything(),
    );
    const titles = {
      requested: 'Hold requested · acknowledgements pending',
      acknowledged: 'Acknowledged · application pending',
      applied: 'Hold applied',
      released: 'Hold released · revalidation required',
    };
    expect(screen.getByRole('heading', { name: titles[stage] })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Release held leads' })).toBeNull();
    expect(control.mock.calls.map(([command]) => command.operation)).toEqual(['inbox']);
    if (stage === 'requested') expect(card.textContent).not.toContain('Hold applied');
    if (stage === 'released')
      expect(card.textContent).toContain('Current-main revalidation is required');
  },
);

it('does not send a null priority identity to the real canonical record owner for an operator pause', async () => {
  const operator = TelosWorkControlViewSchema.parse({
    ...receipt(),
    origin: 'operator_pause',
    coordinatorConversationId: null,
    priorityItemId: null,
  });
  vi.spyOn(TelosWorkApiClient.prototype, 'control').mockResolvedValue([operator]);
  render(<TelosWorkControls data={data} conversationId="coordinator-chat" />);
  await screen.findByText('Hold requested · acknowledgements pending');
  await waitFor(() => expect(TelosWorkApiClient.prototype.readRecord).toHaveBeenCalled());
  expect(
    vi
      .mocked(TelosWorkApiClient.prototype.readRecord)
      .mock.calls.every(([id]) => typeof id === 'string' && id !== 'null'),
  ).toBe(true);
});
