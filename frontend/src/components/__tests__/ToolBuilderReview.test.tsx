// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToolBuilderReview } from '../ToolBuilderReview';
import { apiFetch } from '../../lib/api-fetch';
import type { ToolDraftRecord } from '../../lib/tool-builder-api';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});
const id = '11111111-1111-4111-8111-111111111111';
const record = (): ToolDraftRecord => ({
  status: 'submitted',
  sessionId: 'builder',
  draft: {
    id,
    version: 1,
    name: 'Text length',
    description: 'Count input characters',
    contractDigest: 'a'.repeat(64),
    sourceDigest: 'b'.repeat(64),
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    examples: [{ input: { text: 'abc' }, expected: { length: 3 } }],
    permissions: { behavior: 'read', requiredConnections: [] },
    compatibility: { routes: ['local-api'] },
    testProfile: 'unit',
    files: [
      { path: 'src/index.mts', content: 'export const runTool=({text})=>({length:text.length});' },
    ],
    tests: {
      summary: 'Unit checks passed',
      passed: true,
      complete: true,
      evidenceKind: 'candidate-report',
    },
  },
});
const response = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
function setup(value = record()) {
  let current = structuredClone(value);
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (String(path).endsWith('/review')) {
      const body = JSON.parse(String(init!.body));
      current = { ...current, status: body.decision, review: { ...body, reviewer: 'user' } };
      return response(current);
    }
    if (String(path).endsWith('/publish'))
      return response({ reference: { id: `custom:${id}`, version: 1, revision: 'receipt' } });
    if (String(path).endsWith('/cancel')) {
      current = { ...current, status: 'cancelled' };
      return response(current);
    }
    return response(
      String(path).includes('/drafts/')
        ? current
        : {
            drafts: [{ id, version: 1, name: 'Text length', status: current.status }],
            nextOffset: null,
          },
    );
  });
  const published = vi.fn();
  render(
    <MemoryRouter initialEntries={[`/agent-library?library=tools&toolDraft=${id}&draftVersion=1`]}>
      <ToolBuilderReview tools={[]} onPublished={published} />
    </MemoryRouter>,
  );
  return { published };
}
it('inspects the exact version and accepts separately from installed-source publication', async () => {
  const { published } = setup();
  await screen.findByRole('heading', { name: 'Text length · v1' });
  expect(screen.getByLabelText('Draft source').textContent).toContain('runTool');
  expect(screen.getByRole('button', { name: 'Publish accepted tool' })).toHaveProperty(
    'disabled',
    true,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Accept review' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Publish accepted tool' })).toHaveProperty(
      'disabled',
      false,
    ),
  );
  expect(published).not.toHaveBeenCalled();
  const review = vi.mocked(apiFetch).mock.calls.find(([path]) => String(path).endsWith('/review'))!;
  expect(JSON.parse(String(review[1]!.body))).toEqual({
    decision: 'accepted',
    feedback: '',
    contractDigest: 'a'.repeat(64),
  });
  fireEvent.click(screen.getByRole('button', { name: 'Publish accepted tool' }));
  await screen.findByText(
    'Published. Assign the tool to an agent separately and start a new chat.',
  );
  expect(published).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'Publish accepted tool' })).toHaveProperty(
    'disabled',
    true,
  );
});
it('retains review input after failure and sends independent feedback without publication', async () => {
  setup();
  await screen.findByRole('heading', { name: 'Text length · v1' });
  fireEvent.change(screen.getByLabelText('Review feedback'), {
    target: { value: 'Cover Unicode edge cases' },
  });
  vi.mocked(apiFetch).mockResolvedValueOnce(response({ error: 'Version changed; reload' }, false));
  fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));
  await screen.findByRole('alert');
  expect(screen.getByLabelText('Review feedback')).toHaveProperty(
    'value',
    'Cover Unicode edge cases',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));
  await screen.findByText(
    'Changes requested. Return to the Builder conversation to prepare a new version.',
  );
  expect(vi.mocked(apiFetch).mock.calls.some(([path]) => String(path).endsWith('/publish'))).toBe(
    false,
  );
});
it('keeps review bundle bytes available while the browser starts an attached download', async () => {
  setup();
  await screen.findByRole('heading', { name: 'Text length · v1' });
  const create = vi.fn(() => 'blob:review-bundle');
  const revoke = vi.fn();
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = create;
      static revokeObjectURL = revoke;
    },
  );
  const links: HTMLAnchorElement[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    expect(this.isConnected).toBe(true);
    links.push(this);
  });
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole('button', { name: 'Download review bundle' }));
  expect(links).toHaveLength(1);
  expect(links[0].download).toBe(`tool-draft-${id}-v1.json`);
  expect(links[0].isConnected).toBe(false);
  expect(create).toHaveBeenCalledOnce();
  expect(revoke).not.toHaveBeenCalled();
  vi.runOnlyPendingTimers();
  expect(revoke).toHaveBeenCalledWith('blob:review-bundle');
});
it.each(['unpublished', 'rejected', 'cancelled'] as const)(
  'does not accept or publish a %s version',
  async (status) => {
    setup({ ...record(), status });
    await screen.findByRole('heading', { name: 'Text length · v1' });
    expect(screen.getByRole('button', { name: 'Accept review' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Publish accepted tool' })).toHaveProperty(
      'disabled',
      true,
    );
  },
);
it('keeps an accepted draft and failure visible when installation or qualification is unavailable', async () => {
  const { published } = setup({ ...record(), status: 'accepted' });
  await screen.findByRole('heading', { name: 'Text length · v1' });
  vi.mocked(apiFetch).mockResolvedValueOnce(
    response({ error: 'Exact reviewed implementation is not installed' }, false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Publish accepted tool' }));
  await screen.findByText('Exact reviewed implementation is not installed');
  expect(screen.getByText('Status: accepted')).toBeTruthy();
  expect(published).not.toHaveBeenCalled();
});
it('refuses a response for another version before enabling review actions', async () => {
  setup();
  const original = vi.mocked(apiFetch).getMockImplementation()!;
  vi.mocked(apiFetch).mockImplementation(async (path, init) =>
    String(path).includes('/drafts/')
      ? response({ ...record(), draft: { ...record().draft, version: 2 } })
      : original(path, init),
  );
  await screen.findByText('Requested tool draft version changed. Reload before reviewing.');
  expect(screen.queryByRole('button', { name: 'Accept review' })).toBeNull();
});
it.each(['escape', 'toggle', 'done'] as const)(
  'aborts pending publication on %s, restores focus and retains the draft',
  async (method) => {
    const { published } = setup({ ...record(), status: 'accepted' });
    await screen.findByRole('heading', { name: 'Text length · v1' });
    let signal: AbortSignal | undefined;
    vi.mocked(apiFetch).mockImplementationOnce(async (_path, init) => {
      signal = init!.signal as AbortSignal;
      return new Promise((_resolve, reject) =>
        signal!.addEventListener('abort', () => reject(Error('Aborted')), { once: true }),
      );
    });
    fireEvent.click(screen.getByRole('button', { name: 'Publish accepted tool' }));
    await screen.findByText('Qualifying installed implementation…');
    if (method === 'escape')
      fireEvent.keyDown(screen.getByRole('region', { name: 'Tool draft review' }), {
        key: 'Escape',
      });
    else
      fireEvent.click(
        screen.getByRole('button', {
          name: method === 'toggle' ? 'Review tool drafts' : 'Done reviewing',
        }),
      );
    expect(signal?.aborted).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Review tool drafts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review tool drafts' }));
    await screen.findByText('Request cancelled. Reload to confirm the saved state.');
    expect(published).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Text length · v1' })).toBeTruthy();
  },
);

it.each(['failed', 'cancelled'] as const)(
  'retries an exact older deep link after the initial read is %s before a record exists',
  async (action) => {
    setup();
    let reads = 0;
    vi.mocked(apiFetch).mockImplementation(async (path, init) => {
      if (String(path).includes('/drafts/')) {
        reads++;
        expect(String(path).endsWith(`/drafts/${id}/1`)).toBe(true);
        if (reads === 1) {
          if (action === 'failed') return response({ error: 'Read unavailable' }, false);
          const signal = init!.signal!;
          return new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(Error('Aborted')), { once: true }),
          );
        }
        return response({
          ...record(),
          status: 'rejected',
          review: {
            decision: 'rejected',
            feedback: 'Use version two',
            contractDigest: record().draft.contractDigest,
            reviewer: 'operator',
          },
        });
      }
      return response({
        drafts: [{ id, version: 2, name: 'Newer text length', status: 'submitted' }],
        nextOffset: null,
      });
    });
    await waitFor(() => expect(reads).toBe(1));
    if (action === 'cancelled')
      fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    await screen.findByText(
      action === 'failed'
        ? 'Read unavailable'
        : 'Request cancelled. Reload to confirm the saved state.',
    );
    expect(screen.queryByRole('heading', { name: 'Text length · v1' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reload tool drafts' }));
    await screen.findByRole('heading', { name: 'Text length · v1' });
    expect(reads).toBe(2);
    expect(screen.getByText('Review feedback: Use version two')).toBeTruthy();
    expect(screen.getByLabelText('Saved tool draft')).toHaveProperty('value', `${id}:1`);
  },
);
