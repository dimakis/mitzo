import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Minimal publisher selection fixture; no runtime, credentials or model. */
export function hostKnowledgePublication(root: string, id: string, content: string) {
  const directory = join(root, id);
  const seed = join(directory, 'mgmt');
  mkdirSync(join(seed, 'memory/Observations'), { recursive: true });
  writeFileSync(join(seed, 'memory/Observations/lesson.md'), content);
  const baseline = Buffer.from(
    JSON.stringify({
      startingCommit: id.repeat(40),
      files: {
        'memory/Observations/lesson.md': {
          sha256: createHash('sha256').update(content).digest('hex'),
          mode: '100644',
        },
      },
    }),
  );
  writeFileSync(join(directory, 'baseline.json'), baseline);
  return {
    seed,
    sourceCommit: id.repeat(40),
    baselineSha256: createHash('sha256').update(baseline).digest('hex'),
  };
}
