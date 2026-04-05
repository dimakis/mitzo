import { randomBytes } from 'crypto';

/** Shared token for MCP server → Mitzo API calls (generated once at startup). */
export const INTERNAL_TOKEN = randomBytes(32).toString('hex');
