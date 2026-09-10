import { pathToFileURL } from 'node:url';

const workspaceRoot = process.argv[2];
const tokenBudget = Number(process.argv[3] ?? 12_000);
if (!workspaceRoot?.startsWith('/sandbox/workspaces/'))
  throw new Error('workspace root must be inside /sandbox/workspaces');
if (!Number.isInteger(tokenBudget) || tokenBudget < 1 || tokenBudget > 100_000)
  throw new Error('invalid token budget');

const modulePath = process.env.MITZO_CONTEXGIN_MODULE ?? '/usr/lib/contexgin/dist/index.js';
const { compile } = await import(pathToFileURL(modulePath).href);
const compiled = await compile({ workspaceRoot, tokenBudget });

const included = [...(compiled.contextBlocks ?? new Map())].map(([heading, content]) => ({
  source: heading,
  heading,
  tokens: Math.ceil(Buffer.byteLength(content, 'utf8') / 4),
  content,
}));
const trimmed = (compiled.trimmed ?? []).map((section) => ({
  source: section.source?.relativePath ?? section.source?.path ?? 'unknown',
  heading: section.headingPath?.join(' > ') ?? 'unknown',
  tokens: section.tokenEstimate ?? Math.ceil(Buffer.byteLength(section.content ?? '', 'utf8') / 4),
  content: section.content ?? '',
}));

process.stdout.write(
  `${JSON.stringify({
    type: 'boot_context',
    source: 'contexgin',
    scope: 'sandbox',
    sourceCount: compiled.sources.length,
    tokenCount: compiled.bootTokens,
    tokenBudget,
    sources: compiled.sources.map((source) => ({
      path: source.relativePath,
      kind: source.kind,
    })),
    included,
    trimmed,
    fullMarkdown: compiled.bootPayload,
  })}\n`,
);
