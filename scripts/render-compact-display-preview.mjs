import { build } from 'esbuild';
import { readFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { gzipSync } from 'node:zlib';

// Bundle the real components with a sample backend and memory-only storage.
const result = await build({
  entryPoints: ['tests/fixtures/compact-display-preview.ts'],
  bundle: true,
  write: false,
  outfile: '/tmp/compact-display-preview.js',
  jsx: 'automatic',
  minify: true,
  external: ['/*.png', '/*.svg'],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  alias: {
    '@mitzo/protocol': resolve('packages/protocol/src/index.ts'),
    '@mitzo/client/hooks': resolve('packages/client/src/hooks/index.ts'),
    '@mitzo/client': resolve('packages/client/src/index.ts'),
  },
});
let code = result.outputFiles.find((file) => file.path.endsWith('.js')).text;
let css = result.outputFiles.find((file) => file.path.endsWith('.css')).text;
for (const name of [
  'mitzo-icon.png',
  'mitzo-wordmark.png',
  'openshell-mark.svg',
  'github-mark.svg',
]) {
  const data = (await readFile(`frontend/public/${name}`)).toString('base64');
  const uri = `data:image/${name.endsWith('.svg') ? 'svg+xml' : 'png'};base64,${data}`;
  code = code.replaceAll(JSON.stringify('/' + name), JSON.stringify(uri));
  css = css.replaceAll('/' + name, uri);
}
const tokens = await readFile('frontend/src/styles/tokens.css', 'utf8');
const payload = gzipSync(JSON.stringify({ code, css })).toString('base64');
const html = `<!doctype html><html lang="en" data-theme="dark" data-accent="mint"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Compact file viewer and steady draft status</title><style>${tokens}
body{margin:0;background:var(--color-bg);color:var(--color-text);font-family:var(--font-ui)}
.preview-controls{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--space-2);padding:var(--space-2);align-items:center;border-bottom:1px solid var(--color-border)}
.preview-controls label{display:grid;min-width:0;gap:var(--space-1);font-size:var(--text-xs);color:var(--color-muted)}
.preview-controls select{box-sizing:border-box;width:100%;min-width:0;font:inherit;font-size:var(--text-base);min-height:var(--control-height);background:var(--color-surface);color:var(--color-text);border:1px solid var(--color-border);border-radius:var(--radius-control);padding:var(--space-2)}
.preview-controls select:focus-visible{outline:2px solid var(--color-accent);outline-offset:2px}
.preview-caption{font-size:var(--text-sm);color:var(--color-muted);padding:0 var(--space-3)}
.preview-stage{overflow:auto;padding:var(--space-3);display:flex;justify-content:center}
#root{position:relative;isolation:isolate;transform:translateZ(0);flex-shrink:0;border:1px solid var(--color-border);max-width:100%;height:852px;background:var(--color-bg);overflow:hidden}
#root .mobile-workspace{position:absolute;inset:0;height:100%}
#root .chat-page,#root .viewer-page{height:100%}
</style></head><body>
<div class="preview-controls">
<label>Screen<select id="screen"><option value="393">Phone</option><option value="320">320px</option><option value="1280">Desktop</option></select></label>
<label>Theme<select id="theme"><option value="dark">Dark</option><option value="light">Light</option></select></label>
<label>View<select id="view"><option value="/files?path=v001.md">File</option><option value="/chat">Draft</option></select></label>
</div>
<p class="preview-caption">Actual components with sample content. All preview edits stay in memory; switching views resets them. Browser layout verification is pending.</p>
<div class="preview-stage"><div id="root" aria-label="Compact Mitzo preview"></div></div>
<script>
function showPreview(){
  const theme=document.getElementById('theme').value;
  document.documentElement.dataset.theme=theme;
  document.documentElement.dataset.accent=theme==='dark'?'mint':'teal';
  document.documentElement.dataset.font=theme==='dark'?'system':'georgia';
  window.compactDisplayWidth=document.getElementById('screen').value;
  window.compactDisplayRoute=document.getElementById('view').value;
  document.getElementById('root').style.width=window.compactDisplayWidth+'px';
  window.renderCompactDisplay?.();
}
document.querySelectorAll('.preview-controls select').forEach(control=>control.addEventListener('change',showPreview));
showPreview();
(async()=>{
  const bytes=Uint8Array.from(atob('${payload}'),c=>c.charCodeAt(0));
  const data=JSON.parse(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
  const style=document.createElement('style');style.textContent=data.css;document.head.prepend(style);
  const script=document.createElement('script');script.src=URL.createObjectURL(new Blob([data.code],{type:'application/javascript'}));document.body.append(script);
})().catch(error=>{document.getElementById('root').textContent='Preview could not load: '+error.message;});
</script></body></html>`;
const directory = 'mockups/compact-file-viewer';
await mkdir(directory, { recursive: true });
const existing = new Set(await readdir(directory));
let revision = 1;
while (existing.has(`v${String(revision).padStart(3, '0')}.html`)) revision++;
const path = `${directory}/v${String(revision).padStart(3, '0')}.html`;
await writeFile(path, html, { flag: 'wx' });
process.stdout.write(path + '\n');
