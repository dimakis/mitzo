import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

const [entryPath, encodedExamples] = process.argv.slice(2);
if (!entryPath || !encodedExamples) throw new Error('Example runner arguments are required');
const examples = JSON.parse(Buffer.from(encodedExamples, 'base64url').toString('utf8'));
const implementation = await import(pathToFileURL(entryPath).href);
if (typeof implementation.runTool !== 'function')
  throw new Error('Implementation must export runTool(input)');
const results = [];
for (const example of examples) {
  try {
    const actual = await implementation.runTool(example.input);
    const passed = isDeepStrictEqual(actual, example.expected);
    results.push({ actual, passed });
  } catch {
    results.push({ actual: { error: 'Example threw an error' }, passed: false });
  }
}
process.stdout.write(JSON.stringify({ complete: true, results }));
