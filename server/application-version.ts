import { createRequire } from 'node:module';

/** Shared version for protocol handshakes, read from the installed package. */
export const applicationVersion: string = createRequire(import.meta.url)('../package.json').version;
