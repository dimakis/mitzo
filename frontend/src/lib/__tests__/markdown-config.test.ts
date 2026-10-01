import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownCodeBlock } from '../../components/MarkdownCodeBlock';
import { MermaidBlock } from '../../components/MermaidBlock';

describe('MarkdownCodeBlock', () => {
  it('routes a Mermaid fence to the diagram component', () => {
    const result = MarkdownCodeBlock({
      children: createElement('code', { className: 'language-mermaid' }, 'graph TD; A-->B;'),
    });
    expect(result.type).toBe(MermaidBlock);
    expect(result.props.code).toBe('graph TD; A-->B;');
  });
  it.each(['language-python', undefined])(
    'keeps ordinary code and its copy control: %s',
    (className) => {
      const html = renderToStaticMarkup(
        createElement(MarkdownCodeBlock, {
          children: createElement('code', { className }, 'print("hi")'),
        }),
      );
      expect(html).toContain('code-block-wrapper');
      expect(html).toContain('Copy code');
      expect(html).toContain('print');
    },
  );
});
