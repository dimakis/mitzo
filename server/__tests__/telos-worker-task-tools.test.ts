import { afterEach, expect, it, vi } from 'vitest';
import {
  executeTelosWorkerTaskTool,
  telosWorkerTaskDefinitions,
} from '../telos-worker-task-tools.js';

afterEach(() => vi.unstubAllGlobals());
it('offers only four exact task-board tools and distinguishes a saved completion from verified outcome', () => {
  expect(telosWorkerTaskDefinitions.map((tool) => tool.name)).toEqual([
    'mcp__task-board__TaskStatus',
    'mcp__task-board__TaskComplete',
    'mcp__task-board__TaskBlock',
    'mcp__task-board__TaskArtifact',
  ]);
  expect(
    telosWorkerTaskDefinitions.find((tool) => tool.name.endsWith('TaskComplete'))?.description,
  ).toContain('pending_review');
});
it.each([
  ['mcp__task-board__TaskStatus', {}, 'GET', 'status'],
  ['mcp__task-board__TaskComplete', { summary: 'Saved evidence' }, 'POST', 'complete'],
  ['mcp__task-board__TaskBlock', { reason: 'Needs review' }, 'POST', 'block'],
  ['mcp__task-board__TaskArtifact', { key: 'report', value: 'artifact:abc@1' }, 'POST', 'artifact'],
] as const)(
  'routes %s through the existing task owner without accepting a task id',
  async (name, input, method, operation) => {
    const pending = 'Task "Slice" marked as pending_review — awaiting approval.';
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: pending })));
    vi.stubGlobal('fetch', fetch);
    expect(
      await executeTelosWorkerTaskTool(
        'http://host',
        'client',
        'worker-session',
        'exact-task',
        'secret',
        name,
        input,
      ),
    ).toEqual({ content: pending, isError: false });
    const init = fetch.mock.calls[0][1];
    expect(fetch.mock.calls[0][0]).toBe(`http://host/api/internal/task-tools/${operation}`);
    expect(init).toMatchObject({
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': 'secret',
        'X-Client-Id': 'client',
        'X-Task-Session-Id': 'worker-session',
        'X-Task-Id': 'exact-task',
      },
    });
    if (method === 'POST') expect(JSON.parse(init.body)).toEqual(input);
    else expect(init).not.toHaveProperty('body');
  },
);
it.each([
  ['mcp__task-board__TaskSet', { tasks: [] }],
  ['TaskComplete', { summary: 'Spoof' }],
  ['mcp__task-board__TaskStatus', { taskId: 'other' }],
  ['mcp__task-board__TaskComplete', { summary: ' ' }],
  ['mcp__task-board__TaskComplete', { summary: 'Fine', taskId: 'other' }],
  ['mcp__task-board__TaskBlock', { reason: '' }],
  ['mcp__task-board__TaskArtifact', { key: '', value: 'x' }],
])(
  'rejects unauthorized names or invalid task inputs before contacting host %#',
  async (name, input) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(
      (
        await executeTelosWorkerTaskTool(
          'http://host',
          'client',
          'worker-session',
          'exact-task',
          'secret',
          name,
          input,
        )
      ).isError,
    ).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  },
);
it('preserves denied, malformed and uncertain results without reporting successful completion', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Scope changed' }), { status: 403 }),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ result: 'Error: task not found' })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))
    .mockRejectedValueOnce(new Error('response lost'));
  vi.stubGlobal('fetch', fetch);
  for (let i = 0; i < 4; i++)
    expect(
      (
        await executeTelosWorkerTaskTool(
          'http://host',
          'client',
          'worker-session',
          'exact-task',
          'secret',
          'mcp__task-board__TaskComplete',
          { summary: 'Evidence' },
        )
      ).isError,
    ).toBe(true);
});
it('requires current client identity and honours cancellation before fetch', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  expect(
    (
      await executeTelosWorkerTaskTool(
        'http://host',
        '',
        'worker-session',
        'exact-task',
        'secret',
        'mcp__task-board__TaskStatus',
        {},
      )
    ).isError,
  ).toBe(true);
  const controller = new AbortController();
  controller.abort();
  expect(
    (
      await executeTelosWorkerTaskTool(
        'http://host',
        'client',
        'worker-session',
        'exact-task',
        'secret',
        'mcp__task-board__TaskStatus',
        {},
        controller.signal,
      )
    ).isError,
  ).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});
