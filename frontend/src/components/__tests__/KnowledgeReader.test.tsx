// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { KnowledgeReader } from '../KnowledgeReader';
afterEach(cleanup);
it('keeps accepted relative links in Knowledge and uses safe mobile Markdown rendering', () => {
  const onOpen = vi.fn();
  const known = { path: 'hub/context/guide.md', title: 'Guide', area: 'Hub' };
  const { container } = render(
    <KnowledgeReader
      document={{ path: 'hub/principles.md', title: 'Principles', area: 'Hub' }}
      content={
        '# Principles\n\n[Guide](context/guide.md) [Unknown](private/secret.md) [Host file](/Users/person/private.md) [External](https://example.com)\n\n| One | Two |\n| --- | --- |\n| value | value |\n\n```ts\nconst answer = 42;\n```\n\n<script>window.bad = true</script><img src="x" onerror="alert(1)">'
      }
      busy={false}
      onBack={() => {}}
      onEdit={() => {}}
      documents={[known]}
      onOpen={onOpen}
    />,
  );
  fireEvent.click(screen.getByRole('link', { name: 'Guide' }));
  expect(onOpen).toHaveBeenCalledWith(known);
  expect(screen.queryByRole('link', { name: 'Unknown' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Host file' })).toBeNull();
  expect(screen.getByRole('link', { name: 'External' }).getAttribute('href')).toBe(
    'https://example.com',
  );
  expect(container.querySelector('.table-scroll-wrapper table')).toBeTruthy();
  expect(container.querySelector('.code-block-wrapper pre')).toBeTruthy();
  expect(container.querySelector('script')).toBeNull();
  expect(container.querySelector('img')?.hasAttribute('onerror')).toBe(false);
});
