import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createTelosCanonicalData } from './fixtures/telos-canonical-advisor.js';
import { TelosItemStore } from '../telos-item-store.js';
import {
  executeTelosBacklogOperation,
  telosBacklogDefinitions,
  type TelosBacklogToolName,
} from '../telos-backlog-tools.js';
import { createIntegrationToolDiscovery } from '../integration-tool-discovery.js';

const cleanup: Array<() => void> = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
function fixture() {
  const f = createTelosCanonicalData();
  cleanup.push(() => f.close());
  const items = new TelosItemStore(f.dbPath);
  cleanup.push(() => items.close());
  let current = true;
  const assertCurrentSync = () => {
    if (!current) throw Error('retired');
  };
  const approve = vi.fn(async (_name: string, input: Record<string, unknown>) => ({
    behavior: 'allow' as const,
    updatedInput: input,
  }));
  const run = (name: TelosBacklogToolName, raw: Record<string, unknown>) =>
    executeTelosBacklogOperation(
      {
        items,
        work: f.work,
        approve,
        context: {
          operatorId: f.actor.id,
          conversationId: 'ordinary-chat',
          toolName: name,
          requestHash: createHash('sha256').update(JSON.stringify(raw)).digest('hex'),
          signal: new AbortController().signal,
          assertCurrentSync,
          async assertCurrent() {
            assertCurrentSync();
          },
        },
      },
      name,
      raw,
    );
  return {
    ...f,
    items,
    run,
    approve,
    retire: () => {
      current = false;
    },
  };
}
it('discovers list, search and maintenance contracts by their exact callable identity', async () => {
  const f = fixture();
  const discovery = createIntegrationToolDiscovery({
    tools: [],
    directTools: telosBacklogDefinitions,
    directOnly: true,
    displayName: (name) => name,
    assertCurrent() {},
    execute: f.run as never,
  });
  const list = JSON.parse(
    (
      await discovery.execute(
        'ListIntegrationTools',
        { query: 'Telos' },
        new AbortController().signal,
      )
    ).content,
  );
  expect(list.tools.map((t) => t.toolId)).toEqual([
    'TelosListItems',
    'TelosSearchItems',
    'TelosManageItem',
  ]);
  for (const { toolId } of list.tools) {
    const described = await discovery.execute(
      'DescribeIntegrationTool',
      { toolId },
      new AbortController().signal,
    );
    expect(described.isError).toBe(false);
    expect(JSON.parse(described.content)).toMatchObject({
      toolId,
      invocation: 'direct',
      inputSchema: { type: 'object' },
    });
  }
});
it('lets an ordinary authenticated chat find and inspect an item without assigning a lead role', async () => {
  const f = fixture();
  const list = await f.run('TelosSearchItems', { query: 'studio' });
  expect(list.isError).toBe(false);
  expect(JSON.parse(list.content).items.map((i) => i.id)).toEqual(['studio']);
  expect(f.approve).not.toHaveBeenCalled();
  const read = await f.run('TelosManageItem', { operation: 'read', itemId: 'studio' });
  expect(JSON.parse(read.content)).toMatchObject({
    item: { id: 'studio', summary: 'Home studio' },
    lifecycle: { itemId: 'studio', disposition: 'active' },
  });
});
it('approves exact brief edits and canonical archive/unarchive with retryable receipts', async () => {
  const f = fixture();
  const edit = {
    operation: 'edit',
    itemId: 'studio',
    requestId: 'edit',
    expectedRevision: f.items.read('studio').revision,
    summary: 'Select studio panels',
    note: 'Make the title actionable.',
  };
  expect((await f.run('TelosManageItem', edit)).isError).toBe(false);
  expect(f.items.read('studio')).toMatchObject({ summary: edit.summary, status: 'active' });
  const command = {
    operation: 'archive',
    itemId: 'studio',
    requestId: 'archive',
    expectedRevision: f.work.readLifecycle('studio', f.actor).revision,
  };
  const archive = await f.run('TelosManageItem', command);
  expect(archive.isError).toBe(false);
  expect(await f.run('TelosManageItem', command)).toEqual(archive);
  expect(JSON.parse((await f.run('TelosListItems', {})).content).items).toEqual([]);
  expect(
    (
      await f.run('TelosManageItem', {
        ...command,
        operation: 'unarchive',
        requestId: 'unarchive',
        expectedRevision: f.work.readLifecycle('studio', f.actor).revision,
      })
    ).isError,
  ).toBe(false);
  expect(f.items.read('studio').status).toBe('active');
});
it('rejects destructive, empty, spoofed and approval-modified requests, including retirement during approval', async () => {
  const f = fixture();
  for (const raw of [
    { operation: 'delete_permanently', itemId: 'studio' },
    { operation: 'read', itemId: 'studio', operatorId: 'spoofed' },
    {
      operation: 'edit',
      itemId: 'studio',
      requestId: 'empty',
      expectedRevision: f.items.read('studio').revision,
      note: 'Nothing',
    },
  ])
    expect((await f.run('TelosManageItem', raw)).isError).toBe(true);
  const edit = {
    operation: 'edit',
    itemId: 'studio',
    requestId: 'edit',
    expectedRevision: f.items.read('studio').revision,
    summary: 'Changed',
    note: 'Rename',
  };
  f.approve.mockImplementationOnce(async (_name, input) => ({
    behavior: 'allow',
    updatedInput: { ...input, summary: 'Substituted' },
  }));
  expect((await f.run('TelosManageItem', edit)).isError).toBe(true);
  f.approve.mockImplementationOnce(async (_name, input) => {
    f.retire();
    return { behavior: 'allow', updatedInput: input };
  });
  expect((await f.run('TelosManageItem', edit)).isError).toBe(true);
  expect(f.items.read('studio').summary).toBe('Home studio');
});
