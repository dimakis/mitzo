import { readdir, readFile, stat, realpath } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { parseInboxItem } from './inbox.js';
import { privateCodexPathSnapshot } from './codex-private-path.js';

export interface InboxSource extends ReturnType<typeof parseInboxItem> {
  source: string;
  version: string;
  identity: string;
  modified: number;
}
/** Content reuse is independent of authority. Every scan captures current
 * privacy and resolves every source; no visibility decision survives a scan. */
export class InboxScanner {
  private cache = new Map<string, InboxSource>();
  async scan(directory: string): Promise<InboxSource[]> {
    const policy = privateCodexPathSnapshot();
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }
    const paths = names
      .filter((name) => basename(name) === name && !name.includes('..') && name.endsWith('.md'))
      .map((name) => join(directory, name));
    const seen = new Set(paths);
    for (const path of this.cache.keys())
      if (dirname(path) === directory && !seen.has(path)) this.cache.delete(path);
    const remaining = paths.values();
    const results: InboxSource[] = [];
    await Promise.all(
      Array.from({ length: Math.min(4, paths.length) }, async () => {
        for (const path of remaining) {
          if (policy.isPrivate(path)) {
            this.cache.delete(path);
            continue;
          }
          try {
            const info = await stat(path, { bigint: true });
            if (!info.isFile()) continue;
            const source = await realpath(path);
            const version = `${source}:${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
            const cached = this.cache.get(path);
            if (cached?.version === version) {
              results.push(cached);
              continue;
            }
            const content = await readFile(path, 'utf8');
            const after = await stat(path, { bigint: true });
            if (
              after.ino !== info.ino ||
              after.size !== info.size ||
              after.ctimeNs !== info.ctimeNs
            )
              continue;
            const item = {
              ...parseInboxItem(basename(path), content),
              source,
              version,
              identity: `${info.dev}:${info.ino}`,
              modified: Number(info.mtimeMs),
            };
            this.cache.set(path, item);
            results.push(item);
          } catch (error) {
            this.cache.delete(path);
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
              throw error;
          }
        }
      }),
    );
    return results.sort((a, b) => b.summary.filename.localeCompare(a.summary.filename));
  }
}
