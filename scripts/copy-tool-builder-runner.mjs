import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'server', 'tool-builder-example-runner.mjs');
const target = join(root, 'dist', 'tool-builder-example-runner.mjs');
await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
