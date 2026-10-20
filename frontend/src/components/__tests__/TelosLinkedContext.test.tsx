// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { TelosWorkRoleContextSelection } from '@mitzo/protocol';
import { TelosLinkedContext } from '../TelosLinkedContext';
import { sha256Hex } from '../../lib/browser-crypto';
import { shareTelosArtifact } from '../../lib/share-file';
vi.mock('../../lib/share-file', () => ({ shareTelosArtifact: vi.fn(async () => {}) }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const artifact = { artifactId: 'a'.repeat(32), revision: 2, sha256: 'b'.repeat(64) };
function context(): TelosWorkRoleContextSelection {
  return {
    version: 1,
    itemId: 'item',
    role: 'lead',
    brief: {
      revision: 'brief-v2',
      sha256: 'a'.repeat(64),
      text: JSON.stringify({
        summary: 'Studio plan',
        intent: 'Record the agreed session',
        rationale: 'Make a first recording',
        acceptanceCriteria: ['Retained recording'],
        taskHint: 'Plan equipment',
      }),
    },
    parentCriteria: [
      { itemId: 'parent', revision: 'parent-v3', criteria: ['Meet the agreed budget'] },
    ],
    overallGoal: { itemId: 'goal', revision: 'goal-v1', text: 'Create a home studio' },
    sources: [
      {
        version: 1,
        snapshotId: 'selected',
        itemId: 'item',
        source: { namespace: 'mitzo', conversationId: 'planning' },
        selection: { kind: 'selected', messageIds: ['message'], blockIds: [], throughSequence: 12 },
        adoptedBrief: null,
        artifacts: [],
        author: null,
        sourceCreatedAt: null,
        adoptedAt: null,
      },
    ],
    artifacts: [artifact],
  };
}
it('renders canonical human fields, goal and parent criteria with exact retained provenance and real source/material actions', async () => {
  render(
    <MemoryRouter>
      <TelosLinkedContext context={context()} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByText('Linked brief · goal & parent context'));
  expect(screen.getByText('Studio plan')).toBeTruthy();
  expect(screen.getByText('Record the agreed session')).toBeTruthy();
  expect(screen.getByText('Retained recording')).toBeTruthy();
  expect(screen.getByText('Meet the agreed budget')).toBeTruthy();
  expect(screen.getByText('Create a home studio')).toBeTruthy();
  expect(screen.queryByText(/\{"summary"/)).toBeNull();
  expect(screen.getByRole('link', { name: 'Open original chat' }).getAttribute('href')).toBe(
    '/chat/planning?telosItem=item&telosSource=selected',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open material revision 2' }));
  await waitFor(() =>
    expect(shareTelosArtifact).toHaveBeenCalledWith(
      `/api/telos/artifacts/${artifact.artifactId}?revision=2`,
    ),
  );
});
it('preserves a plain-text reviewed brief without parsing it into invented fields', () => {
  const selected = context();
  selected.brief.text = 'A retained plain-text brief.';
  render(
    <MemoryRouter>
      <TelosLinkedContext context={selected} />
    </MemoryRouter>,
  );
  expect(screen.getByText('A retained plain-text brief.')).toBeTruthy();
});
it('uses the retained external original URL and reports an exact material opening failure', async () => {
  const selected = context();
  selected.sources[0].source = {
    namespace: 'external_codex',
    conversationId: 'external',
    url: 'codex://threads/external',
  };
  vi.mocked(shareTelosArtifact).mockRejectedValueOnce(new Error('Retained material unavailable.'));
  render(
    <MemoryRouter>
      <TelosLinkedContext context={selected} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByText('Linked brief · goal & parent context'));
  expect(screen.getByRole('link', { name: 'Open original chat' }).getAttribute('href')).toBe(
    'codex://threads/external',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open material revision 2' }));
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    'Retained material unavailable.',
  );
});

it('CT05: retains exact authority in source and material actions without presenting raw identifiers as the explanation', async () => {
  const selected = context();
  selected.sources[0].snapshotId = 'retained-snapshot-opaque-id';
  selected.sources[0].selection = {
    kind: 'selected',
    messageIds: ['retained-message-opaque-id'],
    blockIds: ['retained-block-opaque-id'],
    throughSequence: 12,
  };
  const original = structuredClone(selected);
  render(
    <MemoryRouter>
      <TelosLinkedContext context={selected} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByText('Linked brief · goal & parent context'));
  expect(screen.getByRole('link', { name: 'Open original chat' }).getAttribute('href')).toBe(
    '/chat/planning?telosItem=item&telosSource=retained-snapshot-opaque-id',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open material revision 2' }));
  await waitFor(() =>
    expect(shareTelosArtifact).toHaveBeenCalledWith(
      `/api/telos/artifacts/${artifact.artifactId}?revision=2`,
    ),
  );
  expect(selected).toEqual(original);
  for (const value of [
    artifact.artifactId,
    artifact.sha256,
    selected.brief.sha256,
    'retained-snapshot-opaque-id',
    'retained-message-opaque-id',
    'retained-block-opaque-id',
  ]) {
    expect(screen.queryByText(value)).toBeNull();
  }
  expect(screen.queryByText('Source snapshot')).toBeNull();
  expect(screen.queryByText('SHA-256')).toBeNull();
  expect(screen.queryByText('Brief SHA-256')).toBeNull();
});

function reviewedPresentation(selected: TelosWorkRoleContextSelection) {
  const presentation = {
    version: 1 as const,
    contextSha256: sha256Hex(JSON.stringify(selected)),
    reviewedAt: '2026-10-18T10:00:00Z',
    item: { itemId: selected.itemId, revision: selected.brief.revision, title: 'Studio plan' },
    overallGoal: {
      itemId: selected.overallGoal.itemId,
      revision: selected.overallGoal.revision,
      title: 'Home studio',
    },
    parents: selected.parentCriteria.map((parent) => ({
      itemId: parent.itemId,
      revision: parent.revision,
      title: 'Recording session plan',
    })),
    sources: selected.sources.map((source) => ({
      snapshotId: source.snapshotId,
      title: 'Studio planning',
      createdAt: '2026-10-16T10:00:00Z',
    })),
    artifacts: selected.artifacts.map((material) => ({
      ...material,
      filename: 'acoustic-plan.md',
      title: 'Acoustic plan',
      createdAt: '2026-10-16T09:00:00Z',
    })),
  };
  return {
    presentation,
    presentationRef: {
      id: '89b5166a-c549-4aa8-85f2-65dfbf0f2f81',
      sha256: sha256Hex(JSON.stringify(presentation)),
    },
  };
}
it('CT05: renders actual reviewed names, source date and exact material revision metadata without a disclosure fetch', async () => {
  const selected = context();
  const original = structuredClone(selected);
  const props = { context: selected, ...reviewedPresentation(selected) };
  render(
    <MemoryRouter>
      <TelosLinkedContext {...props} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByText('Linked brief · goal & parent context'));
  expect(screen.getByText('Home studio')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Recording session plan' }).getAttribute('href')).toBe(
    '/todos/parent',
  );
  expect(screen.getByText('Studio planning')).toBeTruthy();
  expect(document.querySelector('time[datetime="2026-10-16T10:00:00Z"]')).not.toBeNull();
  expect(screen.getByText(/Acoustic plan/)).toBeTruthy();
  expect(screen.getByText(/acoustic-plan.md/)).toBeTruthy();
  expect(shareTelosArtifact).not.toHaveBeenCalled();
  expect(screen.getByRole('link', { name: 'Open original chat' }).getAttribute('href')).toBe(
    '/chat/planning?telosItem=item&telosSource=selected',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open material revision 2' }));
  await waitFor(() =>
    expect(shareTelosArtifact).toHaveBeenCalledExactlyOnceWith(
      `/api/telos/artifacts/${artifact.artifactId}?revision=2`,
    ),
  );
  expect(selected).toEqual(original);
});
it.each(['ancestor', 'material', 'reference'] as const)(
  'CT05: %s mismatch cannot present another reviewed projection even with the same brief hash',
  (kind) => {
    const selected = context();
    const pin = reviewedPresentation(selected);
    if (kind === 'ancestor') selected.parentCriteria[0].revision = 'later-parent';
    if (kind === 'material') selected.artifacts[0] = { ...selected.artifacts[0], revision: 3 };
    if (kind === 'reference') pin.presentationRef.sha256 = 'f'.repeat(64);
    const props = { context: selected, ...pin };
    render(
      <MemoryRouter>
        <TelosLinkedContext {...props} />
      </MemoryRouter>,
    );
    expect(screen.queryByText('Recording session plan')).toBeNull();
    expect(screen.queryByText('Studio planning')).toBeNull();
    expect(screen.queryByText(/Acoustic plan/)).toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/unavailable/i);
    expect(shareTelosArtifact).not.toHaveBeenCalled();
  },
);

it('CT05: source-capture retention filenames stay out of the human explanation while their exact material action remains', async () => {
  const selected = context();
  const sourceRecord = { artifactId: 'c'.repeat(32), revision: 1, sha256: 'd'.repeat(64) };
  selected.artifacts.push(sourceRecord);
  const pin = reviewedPresentation(selected);
  const filename = `origin-${'e'.repeat(64)}.json`;
  Object.assign(pin.presentation.artifacts[1], {
    title: 'Original discussion · Studio planning',
    filename,
    sourceKind: 'source_capture',
  });
  pin.presentationRef.sha256 = sha256Hex(JSON.stringify(pin.presentation));
  render(
    <MemoryRouter>
      <TelosLinkedContext context={selected} {...pin} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByText('Linked brief · goal & parent context'));
  expect(screen.getByText('Original discussion · Studio planning')).toBeTruthy();
  expect(screen.queryByText(filename, { exact: false })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open material revision 1' }));
  await waitFor(() =>
    expect(shareTelosArtifact).toHaveBeenCalledWith(
      `/api/telos/artifacts/${sourceRecord.artifactId}?revision=1`,
    ),
  );
  expect(pin.presentation.artifacts[1].filename).toBe(filename);
});
