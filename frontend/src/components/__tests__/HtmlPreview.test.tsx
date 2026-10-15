// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HtmlPreview } from '../HtmlPreview';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  document.head
    .querySelectorAll('meta[data-mitzo-preview-policy]')
    .forEach((meta) => meta.remove());
});

function delivery(frame: HTMLIFrameElement) {
  const post = vi.spyOn(frame.contentWindow!, 'postMessage');
  fireEvent.load(frame);
  return post;
}

describe('HtmlPreview', () => {
  it('uses an isolated HTTP document and transfers bytes only after load', () => {
    const html = '<button onclick="document.body.dataset.clicked=true">Try it</button>';
    const { container } = render(<HtmlPreview html={html} title="Prototype preview" />);
    const frame = container.querySelector('iframe')!;
    expect(frame.getAttribute('src')).toBe('/api/html-preview');
    expect(frame.getAttribute('srcdoc')).toBeNull();
    expect(frame.getAttribute('src')).not.toContain('Try it');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    const post = delivery(frame);
    expect(post).toHaveBeenCalledWith(
      { type: 'mitzo:render-preview', html: expect.stringContaining(html) },
      '*',
    );
    fireEvent.load(frame);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('keeps security metadata before hostile head-like markup in the delivered document', () => {
    const html = '<!-- <head> --><script src="https://attacker.example/exfiltrate.js"></script>';
    const { container } = render(<HtmlPreview html={html} title="Hostile preview" />);
    const post = delivery(container.querySelector('iframe')!);
    const document = (post.mock.calls[0][0] as { html: string }).html;
    expect(document).toMatch(/^<!doctype html><html><head><meta /i);
    expect(document.indexOf('Content-Security-Policy')).toBeLessThan(
      document.indexOf('<!-- <head> -->'),
    );
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain('<meta name="referrer" content="no-referrer">');
  });

  it('uses the configured native server without embedding auth tokens or artifact content in its URL', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://server.example');
    localStorage.setItem('mitzo_auth_token', 'private-token');
    const { container } = render(<HtmlPreview html="private document" title="Native preview" />);
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe(
      'https://server.example/api/html-preview',
    );
    expect(
      document.head.querySelector<HTMLMetaElement>('meta[data-mitzo-preview-policy]')?.content,
    ).toBe("frame-src 'self' https://server.example");
    localStorage.removeItem('mitzo_auth_token');
  });

  it('creates a fresh frame on content changes but preserves it across unrelated renders', () => {
    const { container, rerender } = render(<HtmlPreview html="first" title="Preview" />);
    const first = container.querySelector('iframe')!;
    delivery(first);
    rerender(<HtmlPreview html="first" title="Renamed preview" />);
    expect(container.querySelector('iframe')).toBe(first);
    rerender(<HtmlPreview html="second" title="Preview" />);
    const second = container.querySelector('iframe')!;
    expect(second).not.toBe(first);
    expect(delivery(second)).toHaveBeenCalledWith(
      { type: 'mitzo:render-preview', html: expect.stringContaining('second') },
      '*',
    );
    expect(document.head.querySelectorAll('meta[data-mitzo-preview-policy]')).toHaveLength(1);
  });
});
