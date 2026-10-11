// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SessionBanner } from '../SessionBanner';
import type { BootContextMeta } from '@mitzo/client';
afterEach(cleanup);
it('distinguishes prepared context from provider acceptance and shows exact source provenance', () => {
  const bootContext = {
    source: 'contexgin',
    sourceCount: 1,
    tokenCount: 140,
    tokenBudget: 4000,
    sources: [{ path: 'hub/review.md', kind: 'reference' }],
    included: [],
    trimmed: [],
    fullMarkdown: 'Exact received body',
    receipt: {
      recipeHash: 'a'.repeat(64),
      compilerRevision: 'compiler-v2',
      payloadHash: 'b'.repeat(64),
      status: 'prepared',
      profileId: 'reviewer',
      profileRevision: 3,
      provenance: {
        packs: [{ id: 'review', revision: 2, hash: 'c'.repeat(64) }],
        documents: [
          {
            storeId: 'knowledge',
            path: 'hub/review.md',
            revision: 'd'.repeat(40),
            contentHash: 'e'.repeat(64),
          },
        ],
        omissions: [{ path: 'hub/review.md', heading: 'Background', reason: 'excluded' }],
      },
    },
  } as BootContextMeta;
  const view = render(<SessionBanner bootContext={bootContext} />);
  fireEvent.click(screen.getByRole('button', { name: /1 sources/ }));
  expect(screen.getByText('Prepared · awaiting provider acknowledgment')).toBeTruthy();
  fireEvent.click(screen.getByText(/Boot Context/));
  expect(screen.getByText('review · revision 2')).toBeTruthy();
  expect(screen.getByText(/Background · excluded/)).toBeTruthy();
  view.rerender(
    <SessionBanner
      bootContext={{ ...bootContext, receipt: { ...bootContext.receipt!, status: 'accepted' } }}
    />,
  );
  expect(screen.getByText('Accepted by provider')).toBeTruthy();
});
