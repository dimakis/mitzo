import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { runInNewContext } from 'node:vm';
import { createAppSecurityHeaders } from '../security-headers.js';
import { createHtmlPreviewRouter, HTML_PREVIEW_BOOTSTRAP } from '../html-preview-shell.js';

function app(origins: string[] = []) {
  const instance = express();
  instance.use(createAppSecurityHeaders());
  instance.use(createHtmlPreviewRouter(origins));
  instance.get('/', (_req, res) => res.send('host application'));
  return instance;
}

describe('isolated HTML preview shell', () => {
  it('accepts only a valid render message from its own parent and removes the listener before execution', () => {
    const parent = {};
    let listener: ((event: unknown) => void) | undefined;
    const writes: string[] = [];
    runInNewContext(HTML_PREVIEW_BOOTSTRAP.match(/<script>([\s\S]*)<\/script>/)![1], {
      parent,
      window: {
        addEventListener: (_type: string, callback: (event: unknown) => void) => {
          listener = callback;
        },
        removeEventListener: () => {
          listener = undefined;
        },
      },
      document: {
        open: () => {
          expect(listener).toBeUndefined();
        },
        write: (html: string) => writes.push(html),
        close: () => {},
      },
    });
    listener!({ source: {}, data: { type: 'mitzo:render-preview', html: 'foreign' } });
    listener!({ source: parent, data: { type: 'unknown', html: 'wrong command' } });
    listener!({ source: parent, data: { type: 'mitzo:render-preview', html: 5 } });
    expect(writes).toEqual([]);
    listener!({
      source: parent,
      data: { type: 'mitzo:render-preview', html: '<button>Try</button>' },
    });
    expect(writes).toEqual(['<button>Try</button>']);
    expect(listener).toBeUndefined();
  });
  it('serves an empty script-capable document without relaxing the app CSP', async () => {
    const host = await request(app()).get('/');
    expect(host.headers['content-security-policy']).toContain("script-src 'self'");
    expect(host.headers['content-security-policy']).not.toContain("script-src 'unsafe-inline'");
    expect(host.headers['x-frame-options']).toBe('SAMEORIGIN');
    const shell = await request(app()).get('/api/html-preview');
    expect(shell.status).toBe(200);
    expect(shell.headers['content-type']).toContain('text/html');
    expect(shell.headers['content-security-policy']).toContain("script-src 'unsafe-inline'");
    expect(shell.headers['content-security-policy']).toContain('sandbox allow-scripts');
    expect(shell.headers['content-security-policy']).toContain("connect-src 'none'");
    expect(shell.headers['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(shell.headers['x-frame-options']).toBeUndefined();
    expect(shell.headers['cache-control']).toBe('no-store');
    expect(shell.text).not.toContain('host application');
  });

  it('permits only configured parent origins and keeps artifact bytes out of HTTP', async () => {
    const shell = await request(app(['capacitor://localhost', 'https://mobile.example'])).get(
      '/api/html-preview?html=SHOULD_NOT_APPEAR',
    );
    expect(shell.headers['content-security-policy']).toContain(
      "frame-ancestors 'self' capacitor://localhost https://mobile.example",
    );
    expect(shell.text).not.toContain('SHOULD_NOT_APPEAR');
    expect(shell.headers['set-cookie']).toBeUndefined();
    expect(() => app(['https://host.example/; script-src *'])).toThrow();
  });
});
