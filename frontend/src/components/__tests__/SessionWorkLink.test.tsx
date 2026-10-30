// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SessionWorkLink } from '../SessionWorkLink';
import { markAuthLost } from '../../lib/api-fetch';
import { createTelosWorkFixtures } from '../../test-utils/telos-work-fixtures';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('resolves original canonical report IDs through one shared collection read', async () => {
  markAuthLost();
  const records = createTelosWorkFixtures().homeStudio.items;
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => Response.json({ records, profiles: ['manual'], failures: [] }));
  render(
    <MemoryRouter>
      {records.map((record) => (
        <SessionWorkLink key={record.itemId} taskId={record.itemId} />
      ))}
    </MemoryRouter>,
  );
  for (const record of records)
    expect(await screen.findByRole('link', { name: record.summary })).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(String(fetch.mock.calls[0][0])).toBe('/api/telos/work/collection');
});
