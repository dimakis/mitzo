// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CodeBlock } from '../CodeBlock';

afterEach(() => cleanup());

describe('CodeBlock', () => {
  it('returns empty string for empty code', () => {
    const { container } = render(<CodeBlock code="" />);
    const codeElement = container.querySelector('code');
    expect(codeElement?.innerHTML).toBe('');
  });

  it('produces highlighted output for known languages', () => {
    const pythonCode = 'def hello():\n    print("world")';
    const { container } = render(<CodeBlock code={pythonCode} language="python" />);

    const codeElement = container.querySelector('code');
    expect(codeElement?.innerHTML).toContain('hljs-');
    expect(codeElement?.innerHTML).not.toBe(pythonCode);
  });

  it('falls back to escaped plain text for unknown languages', () => {
    const code = 'some code';
    const { container } = render(<CodeBlock code={code} language="unknown-lang" />);

    const codeElement = container.querySelector('code');
    expect(codeElement?.innerHTML).toBe('some code');
  });

  it('falls back to escaped plain text when no language specified', () => {
    const code = 'function test() {}';
    const { container } = render(<CodeBlock code={code} />);

    const codeElement = container.querySelector('code');
    expect(codeElement?.innerHTML).toBe('function test() {}');
  });

  it('escapes HTML characters in fallback mode', () => {
    const code = '<script>alert("xss")</script> & <div>';
    const { container } = render(<CodeBlock code={code} />);

    const codeElement = container.querySelector('code');
    // Verify critical escaping: angle brackets and ampersands
    expect(codeElement?.innerHTML).toContain('&lt;script&gt;');
    expect(codeElement?.innerHTML).toContain('&lt;/script&gt;');
    expect(codeElement?.innerHTML).toContain('&amp;');
    expect(codeElement?.innerHTML).toContain('&lt;div&gt;');
    // Verify no actual HTML tags were rendered
    expect(codeElement?.querySelector('script')).toBeNull();
    expect(codeElement?.querySelector('div')).toBeNull();
  });

  it('shows label in header when provided', () => {
    render(<CodeBlock code="test" label="main.py" />);
    expect(screen.getByText('main.py')).toBeTruthy();
  });

  it('shows language badge in header when provided with label', () => {
    render(<CodeBlock code="test" language="python" label="main.py" />);
    expect(screen.getByText('python')).toBeTruthy();
  });

  it('renders copy button', () => {
    const { container } = render(<CodeBlock code="test code" label="test.py" />);
    const copyButton = container.querySelector('.code-block-highlight-copy');
    expect(copyButton).toBeTruthy();
  });

  it('renders pop-out button when onPopOut provided with label', () => {
    const onPopOut = vi.fn();
    const { container } = render(<CodeBlock code="test" label="test.py" onPopOut={onPopOut} />);

    const popoutButton = container.querySelector('[aria-label="Open in viewer"]');
    expect(popoutButton).toBeTruthy();
  });

  it('calls onPopOut when pop-out button clicked', () => {
    const onPopOut = vi.fn();
    const { container } = render(<CodeBlock code="test" label="test.py" onPopOut={onPopOut} />);

    const popoutButton = container.querySelector('[aria-label="Open in viewer"]') as HTMLElement;
    fireEvent.click(popoutButton);

    expect(onPopOut).toHaveBeenCalledTimes(1);
  });

  it('shows floating actions when no label provided', () => {
    const onPopOut = vi.fn();
    const { container } = render(<CodeBlock code="test" onPopOut={onPopOut} />);

    expect(container.querySelector('.code-block-highlight-float-actions')).toBeTruthy();
    expect(container.querySelector('.code-block-highlight-copy-float')).toBeTruthy();
    expect(container.querySelector('.code-block-highlight-popout-float')).toBeTruthy();
  });

  it('applies custom className when provided', () => {
    const { container } = render(<CodeBlock code="test" className="custom-class" />);
    expect(container.querySelector('.custom-class')).toBeTruthy();
  });

  it('applies added variant class', () => {
    const { container } = render(<CodeBlock code="test" variant="added" />);
    expect(container.querySelector('.code-block-highlight--added')).toBeTruthy();
  });

  it('applies removed variant class', () => {
    const { container } = render(<CodeBlock code="test" variant="removed" />);
    expect(container.querySelector('.code-block-highlight--removed')).toBeTruthy();
  });

  it('applies custom maxHeight to pre element', () => {
    const { container } = render(<CodeBlock code="test" maxHeight={200} />);
    const pre = container.querySelector('pre');
    expect(pre?.style.maxHeight).toBe('200px');
  });

  it('uses default maxHeight of 400px when not specified', () => {
    const { container } = render(<CodeBlock code="test" />);
    const pre = container.querySelector('pre');
    expect(pre?.style.maxHeight).toBe('400px');
  });
});
