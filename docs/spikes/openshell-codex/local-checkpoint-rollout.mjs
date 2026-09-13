import { closeSync, openSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_ROLLOUT_CANDIDATES = 1024;
const YEAR = /^\d{4}$/;
const MONTH_OR_DAY = /^\d{2}$/;
const ROLLOUT = /^rollout-[^/]+\.jsonl$/;

function entries(directory) {
  return readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function header(path) {
  const descriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(MAX_HEADER_BYTES);
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    const newline = buffer.indexOf(0x0a, 0);
    if (newline <= 0 || newline >= length) return undefined;
    return JSON.parse(buffer.subarray(0, newline).toString('utf8'));
  } catch {
    return undefined;
  } finally {
    closeSync(descriptor);
  }
}

/** Finds the exact resumable rollout without depending on the current year. */
export function findRollout(sessions, thread) {
  let candidates = 0;
  for (const year of entries(sessions)) {
    if (!year.isDirectory() || !YEAR.test(year.name)) continue;
    for (const month of entries(join(sessions, year.name))) {
      if (!month.isDirectory() || !MONTH_OR_DAY.test(month.name)) continue;
      for (const day of entries(join(sessions, year.name, month.name))) {
        if (!day.isDirectory() || !MONTH_OR_DAY.test(day.name)) continue;
        const directory = join(sessions, year.name, month.name, day.name);
        for (const entry of entries(directory)) {
          if (!entry.isFile() || !ROLLOUT.test(entry.name)) continue;
          if (++candidates > MAX_ROLLOUT_CANDIDATES) throw new Error('too many rollout candidates');
          const path = join(directory, entry.name);
          const metadata = header(path);
          if (metadata?.type === 'session_meta' && metadata.payload?.id === thread)
            return { path, metadata };
        }
      }
    }
  }
  return undefined;
}
