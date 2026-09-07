import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
const Alias = z.string().trim().max(80);
/** Presentation-only names, keyed by stable server-owned account ID. */
export class AccountAliases {
  constructor(private file: string) {}
  private read(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    return z.record(z.string(), Alias).parse(JSON.parse(readFileSync(this.file, 'utf8')));
  }
  label(id: string, fallback: string) {
    return this.read()[id] || fallback;
  }
  set(id: string, value: unknown) {
    const alias = Alias.parse(value);
    const current = this.read();
    if (alias) current[id] = alias;
    else delete current[id];
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = this.file + '.tmp';
    writeFileSync(temp, JSON.stringify(current), { mode: 0o600 });
    renameSync(temp, this.file);
  }
}
