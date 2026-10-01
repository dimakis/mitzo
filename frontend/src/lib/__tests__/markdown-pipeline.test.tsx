// @vitest-environment jsdom
import ReactMarkdown from 'react-markdown';
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { markdownComponents, remarkPlugins, rehypePlugins } from '../markdown-config';

vi.mock('../../components/MermaidBlock', () => ({
  MermaidBlock: ({ code }: { code: string }) => <output data-testid="diagram">{code}</output>,
}));
afterEach(cleanup);

function markdown(content: string) {
  return render(
    <ReactMarkdown
      components={markdownComponents}
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
    >
      {content}
    </ReactMarkdown>,
  );
}

describe('sanitized Markdown pipeline', () => {
  it('preserves the Mermaid fence class through the sanitizer', () => {
    markdown('```mermaid\ngraph TD; A-->B;\n```');
    expect(screen.getByTestId('diagram').textContent).toBe('graph TD; A-->B;\n');
  });
  it('retains normal fenced code and copy controls', () => {
    const view = markdown('```python\nprint("hi")\n```');
    expect(view.container.querySelector('code.language-python')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeDefined();
    expect(screen.queryByTestId('diagram')).toBeNull();
  });
  it('strips arbitrary classes and dangerous raw HTML', () => {
    const view = markdown(
      '<pre><code class="language-python attacker">safe</code></pre><img src="x" onerror="alert(1)"><script>alert(1)</script>',
    );
    expect(view.container.innerHTML).not.toMatch(/attacker|onerror|<script/);
    expect(view.container.querySelector('code.language-python')).not.toBeNull();
  });
  it('does not promote a Mermaid-like language name', () => {
    markdown('```mermaid-extended\ngraph TD; A-->B;\n```');
    expect(screen.queryByTestId('diagram')).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeDefined();
  });
});
