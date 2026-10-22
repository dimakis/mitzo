import { expect, it } from 'vitest';
import { build } from 'vite';
import { mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

it('bundles the PDF worker, fonts, character maps and decoders at their runtime URLs', async () => {
  const output = mkdtempSync(join(tmpdir(), 'mitzo-pdf-build-'));
  try {
    await build({
      root: resolve('frontend'),
      configFile: resolve('frontend/vite.config.ts'),
      logLevel: 'silent',
      build: {
        outDir: output,
        emptyOutDir: true,
        rollupOptions: { input: resolve('frontend/src/lib/pdf-to-images.ts') },
      },
    });
    expect(
      readdirSync(join(output, 'assets')).some(
        (name) => name.startsWith('pdf.worker.min-') && name.endsWith('.mjs'),
      ),
    ).toBe(true);
    expect(existsSync(join(output, 'pdfjs/cmaps/UniCNS-UTF32-V.bcmap'))).toBe(true);
    expect(existsSync(join(output, 'pdfjs/standard_fonts/LiberationSans-Regular.ttf'))).toBe(true);
    expect(existsSync(join(output, 'pdfjs/wasm/openjpeg.wasm'))).toBe(true);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}, 15000);
