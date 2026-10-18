// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { TelosWorkRoleContextSelection } from '@mitzo/protocol';
import { TelosLinkedContext } from '../TelosLinkedContext';
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
