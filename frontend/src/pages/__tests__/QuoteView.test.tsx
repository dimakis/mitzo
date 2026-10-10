// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QuoteView } from '../QuoteView';
import { DailyQuoteLink } from '../../components/DailyQuoteLink';
const data = vi.hoisted(() => ({
  quote: {
    date: '2026-10-09',
    quote: {
      id: 'one',
      text: 'Examine your life.',
      author: 'Socrates',
      work: 'Apology',
      translation: 'A verified edition',
      explanation: 'Look closely at your choices.',
      example: 'Question a routine.',
      biography: 'An Athenian philosopher.',
      sourceUrl: 'https://example.com/source',
      explainerUrl: 'https://example.com/explainer',
      authorUrl: 'https://example.com/author',
    },
  },
  fetch: vi.fn(),
}));
vi.mock('../../lib/api-fetch', () => ({ apiFetch: (...args: unknown[]) => data.fetch(...args) }));
afterEach(cleanup);
describe('daily quote', () => {
  it('keeps the home mark tiny and links to the dated cached detail', async () => {
    data.fetch.mockResolvedValue({ ok: true, json: async () => data.quote });
    render(
      <MemoryRouter>
        <DailyQuoteLink date="2026-10-09" />
      </MemoryRouter>,
    );
    expect(
      (await screen.findByRole('link', { name: 'Quote of the day by Socrates' })).getAttribute(
        'href',
      ),
    ).toBe('/quotes/2026-10-09');
    expect(screen.queryByText('Examine your life.')).toBeNull();
  });
  it('shows exact quote, interpretation, example, author and direct source links', async () => {
    data.fetch.mockResolvedValue({ ok: true, json: async () => data.quote });
    render(
      <MemoryRouter initialEntries={['/quotes/2026-10-09']}>
        <Routes>
          <Route path="/quotes/:date" element={<QuoteView />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Examine your life.')).toBeTruthy();
    expect(screen.getByText('Look closely at your choices.')).toBeTruthy();
    expect(screen.getByText('Question a routine.')).toBeTruthy();
    expect(screen.getByText('An Athenian philosopher.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Read the source' }).getAttribute('href')).toBe(
      'https://example.com/source',
    );
    const back = screen.getByRole('link', { name: 'Today' });
    expect(back.querySelector('svg[data-icon="back"][aria-hidden="true"]')).toBeTruthy();
    for (const label of ['Explore the idea', 'Learn about the author', 'Read the source']) {
      const external = screen.getByRole('link', { name: label });
      expect(external.querySelector('svg[data-icon="external"][aria-hidden="true"]')).toBeTruthy();
    }
    expect(data.fetch).toHaveBeenCalledWith('/api/home/quote?date=2026-10-09', expect.anything());
  });
});
