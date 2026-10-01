// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, useNavigate, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextBubble } from '../MessageBubble';
import { apiFetch } from '../../lib/api-fetch';

vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(cleanup);
beforeEach(() =>
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => ({ content: 'Expanded document content' }),
  } as Response),
);

function Harness({ content, sessionId }: { content: string; sessionId: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <>
      <TextBubble content={content} artifactSessionId={sessionId} />
      <button onClick={() => navigate('?panel=files')}>Change panel</button>
      <output data-testid="location">{location.pathname + location.search}</output>
    </>
  );
}

describe('expanded message previews', () => {
  it('survives content, parent and query-string updates while keeping current link routing', async () => {
    const content =
      '[notes](file-path://%2Ftmp%2Fnotes.md)\n\n[other](file-path://%2Ftmp%2Fother.txt)';
    const view = render(
      <MemoryRouter initialEntries={['/chat/session-1']}>
        <Harness content={content} sessionId="session-1" />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /notes.md/ }));
    await screen.findByText('Expanded document content');
    view.rerender(
      <MemoryRouter initialEntries={['/chat/session-1']}>
        <Harness content={content + '\n\nMore tokens'} sessionId="session-1" />
      </MemoryRouter>,
    );
    expect(screen.getByText('Expanded document content')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Change panel' }));
    expect(screen.getByText('Expanded document content')).toBeDefined();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('link', { name: 'other' }));
    const url = new URL(screen.getByTestId('location').textContent!, 'https://mitzo.test');
    expect(url.searchParams.get('from')).toBe('/chat/session-1?panel=files');
    expect(url.searchParams.get('sessionId')).toBe('session-1');
  });
});
