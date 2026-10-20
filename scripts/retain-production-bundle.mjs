import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

const root = process.cwd();
const directory = process.env.MITZO_BUILD_EVIDENCE_DIR;
if (!directory || !isAbsolute(directory))
  throw new Error('Explicit build evidence directory required');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const graph = JSON.parse(readFileSync(join(directory, 'inputs.json'), 'utf8'));
if (!Object.keys(graph.inputs).length) throw new Error('Actual Vite module inputs missing');
for (const [path, hash] of Object.entries(graph.inputs))
  if (sha(readFileSync(resolve(root, path))) !== hash)
    throw new Error(`Build input changed before retention: ${path}`);
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourceTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
if (sourceCommit !== process.env.GITHUB_SHA) throw new Error('CI source identity mismatch');
const outputs = {};
const dist = join(root, 'frontend/dist');
function retain(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) retain(file);
    else if (entry.isFile()) {
      const name = relative(dist, file);
      outputs[name] = sha(readFileSync(file));
      const destination = join(directory, 'frontend', name);
      mkdirSync(resolve(destination, '..'), { recursive: true });
      copyFileSync(file, destination);
    } else throw new Error('Unsupported frontend output entry');
  }
}
retain(dist);
if (!outputs['index.html']) throw new Error('Built frontend entry missing');
copyFileSync('package-lock.json', join(directory, 'installed-package-lock.json'));
const receipt = {
  sourceCommit,
  sourceTree,
  pullRequestHead: process.env.MITZO_PR_HEAD,
  pullRequestBase: process.env.MITZO_PR_BASE,
  run: process.env.GITHUB_RUN_ID,
  attempt: process.env.GITHUB_RUN_ATTEMPT,
  node: process.version,
  inputsSha256: sha(readFileSync(join(directory, 'inputs.json'))),
  outputs,
};
writeFileSync(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
process.stdout.write(
  JSON.stringify({
    sourceCommit,
    inputs: Object.keys(graph.inputs).length,
    outputs: Object.keys(outputs).length,
  }) + '\n',
);
