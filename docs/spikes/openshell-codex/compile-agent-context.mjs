import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import * as compiler from '/usr/lib/contexgin/dist/index.js';
import { compileWorkspaceContext } from '/usr/libexec/mitzo/agent-workspace-context.mjs';

// No environment-selected code, service fetch, discovery or credential access.
const encoded = process.argv[2];
if (!encoded || encoded.length > 65536 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
  throw Error('Invalid bounded agent context request');
const bytes = Buffer.from(encoded, 'base64');
if (bytes.toString('base64') !== encoded) throw Error('Invalid agent context encoding');
const request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
const { workspaceRoot, recipe } = request;
if (Object.keys(request).sort().join(',') !== 'recipe,workspaceRoot')
  throw Error('Invalid agent context request fields');
if (
  typeof workspaceRoot !== 'string' ||
  workspaceRoot.length > 1000 ||
  !workspaceRoot.startsWith('/sandbox/workspaces/') ||
  workspaceRoot
    .split('/')
    .slice(1)
    .some((part) => !part || part === '.' || part === '..')
)
  throw Error('Agent context root must be an authorized sandbox workspace');
if ((await realpath(workspaceRoot)) !== workspaceRoot)
  throw Error('Agent context root must be physical');
let ancestor = '/';
for (const part of workspaceRoot.split('/').slice(1)) {
  ancestor = join(ancestor, part);
  const info = await lstat(ancestor);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw Error('Agent context root must be physical');
}
const reference = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 200 &&
  /^(?:[a-zA-Z0-9_. -]+\/)*[a-zA-Z0-9_. -]+\.(?:md|mdc)$/.test(value) &&
  value
    .split('/')
    .every(
      (part, index) =>
        part !== '.' &&
        part !== '..' &&
        (!part.startsWith('.') ||
          (index === 0 && part === '.cursor' && value.startsWith('.cursor/rules/'))),
    );
const selectors = (value) =>
  Array.isArray(value) &&
  value.length <= 20 &&
  value.every(
    (path) =>
      Array.isArray(path) &&
      path.length >= 1 &&
      path.length <= 8 &&
      path.every(
        (heading) =>
          typeof heading === 'string' &&
          heading === heading.trim() &&
          heading.length >= 1 &&
          heading.length <= 120,
      ),
  );
if (
  !recipe ||
  Object.keys(recipe).sort().join(',') !== 'excluded,files,required,source,tokenBudget,version' ||
  recipe.version !== 1 ||
  recipe.source !== 'workspace' ||
  !Array.isArray(recipe.files) ||
  recipe.files.length > 20 ||
  !recipe.files.every(reference) ||
  new Set(recipe.files).size !== recipe.files.length ||
  !Number.isInteger(recipe.tokenBudget) ||
  recipe.tokenBudget < 256 ||
  recipe.tokenBudget > 32000 ||
  !selectors(recipe.required) ||
  !selectors(recipe.excluded)
)
  throw Error('Invalid sandbox workspace context recipe');
const compiled = await compileWorkspaceContext(
  recipe,
  { workspaceRoot, requirePhysicalRoot: true },
  compiler,
);
const output =
  JSON.stringify({
    compilerRevision: 'mitzo-sandbox-context-v1:contexgin-683f9007db686e710ed9a5410468fe33df1c5382',
    ...compiled,
  }) + '\n';
if (Buffer.byteLength(output) > 1048576)
  throw Error('Compiled agent context response is too large');
// Pinned ContexGin dependencies may retain handles; the one-shot contract ends on flush.
process.stdout.write(output, () => process.exit(0));
