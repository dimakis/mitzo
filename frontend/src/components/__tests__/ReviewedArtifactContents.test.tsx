// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ReviewedArtifactContents } from '../ReviewedArtifactContents';

afterEach(cleanup);

it('preserves UTF-8, whitespace, BOM and literal markup in the frozen content', () => {
  const text = '\ufeff  résumé\n<script>not executable</script>\n';
  render(
    <ReviewedArtifactContents revision={7} contentBase64={Buffer.from(text).toString('base64')} />,
  );
  const contents = screen.getByLabelText('Saved contents, version 7');
  expect(contents.textContent).toBe(text);
  expect(contents.querySelector('script')).toBeNull();
});

it.each(['//4=', 'invalid!', 'AAE='])(
  'shows the complete encoded content when it cannot render UTF-8 (%s)',
  (encoded) => {
    render(<ReviewedArtifactContents revision={2} contentBase64={encoded} />);
    expect(screen.getByText('Encoded contents (Base64)')).toBeTruthy();
    expect(screen.getByLabelText('Saved contents, version 2').textContent).toBe(encoded);
  },
);

it('distinguishes a reference-only snapshot from empty saved contents', () => {
  const view = render(<ReviewedArtifactContents revision={2} />);
  expect(
    screen.getByText('This historical snapshot contains a reference only, without saved contents.'),
  ).toBeTruthy();
  view.rerender(<ReviewedArtifactContents revision={2} contentBase64="" />);
  expect(screen.queryByText(/reference only/)).toBeNull();
  expect(screen.getByLabelText('Saved contents, version 2').textContent).toBe('');
});
