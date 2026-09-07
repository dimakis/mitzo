import type { AccountBinding } from '@mitzo/protocol';
import { generateSessionName, generateSessionNameFallback } from './auto-rename.js';
/** Account-bound task content must not be sent to an implicit naming provider. */
export async function accountSessionName(prompts: string[], binding?: AccountBinding | null) {
  return binding ? generateSessionNameFallback(prompts) : generateSessionName(prompts);
}
