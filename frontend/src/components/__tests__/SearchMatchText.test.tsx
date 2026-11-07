// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { SearchMatchText } from '../SearchMatchText';

afterEach(cleanup);
it('highlights separate terms case-insensitively and preserves the original text', () => {
  const view = render(
    <SearchMatchText text="Personal billing for Claude" query="Claude personal" />,
  );
  expect(view.container.textContent).toBe('Personal billing for Claude');
  expect([...view.container.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual([
    'Personal',
    'Claude',
  ]);
});
it('treats regex characters as literal text and never interprets snippets as HTML', () => {
  const view = render(<SearchMatchText text={'<script>C++ 50%_done</script>'} query="C++ 50%_" />);
  expect(view.container.querySelector('script')).toBeNull();
  expect([...view.container.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual([
    'C++',
    '50%_',
  ]);
});
it('highlights an exact quoted phrase as a unit', () => {
  const view = render(
    <SearchMatchText text="Review Claude personal billing" query={'"Claude personal"'} />,
  );
  expect(view.container.querySelector('mark')?.textContent).toBe('Claude personal');
});
