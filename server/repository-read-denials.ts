import { dirname, isAbsolute, resolve } from 'node:path';

/** Closed SDK private-file families only. These are additional DENIALS on the
 * original default-read policy, never allow rules or model-provided patterns.
 * Unknown future policy needs an explicit adapter rather than silent omission. */
export function freezeDenyOnlyReadPatterns(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 32) throw Error('Unsupported read denial patterns');
  const result: string[] = [];
  for (const pattern of value) {
    if (
      typeof pattern !== 'string' ||
      !isAbsolute(pattern) ||
      pattern.length > 4096 ||
      /[\r\n\0]/.test(pattern) ||
      !/\/\.env\.(?:before-runtime-|runtime-)\*$/.test(pattern) ||
      resolve(dirname(pattern)) !== dirname(pattern) ||
      /[*?[\]{}]/.test(dirname(pattern))
    )
      throw Error('Unsupported read denial pattern');
    result.push(pattern);
  }
  return Object.freeze([...new Set(result)]);
}
