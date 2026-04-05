import type { StoredEvent } from './event-store.js';

/** Every Nth user prompt triggers an auto-rename. */
export const AUTO_RENAME_INTERVAL = 4;

/** Maximum number of recent prompts to consider for name generation. */
const MAX_RECENT_PROMPTS = 8;

/** Maximum length of the generated session name. */
const MAX_NAME_LENGTH = 60;

/** Common stop words to filter out when extracting key terms. */
const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'is',
  'it',
  'be',
  'as',
  'do',
  'if',
  'so',
  'we',
  'my',
  'me',
  'i',
  'that',
  'this',
  'can',
  'also',
  'just',
  'all',
  'not',
  'are',
  'was',
  'has',
  'have',
  'had',
  'been',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'shall',
  'need',
  'want',
  'please',
  'some',
  'any',
  'no',
  'yes',
  'up',
  'out',
  'about',
  'into',
  'over',
  'then',
  'than',
  'them',
  'they',
  'their',
  'there',
  'here',
  'when',
  'what',
  'which',
  'how',
  'who',
  'where',
  'why',
  'each',
  'every',
  'very',
  'too',
  'more',
  'most',
  'other',
  'our',
  'your',
  'its',
  'you',
  'he',
  'she',
  'his',
  'her',
]);

/**
 * Check whether an auto-rename should fire for the given prompt count.
 */
export function shouldAutoRename(promptCount: number, manuallyRenamed: boolean): boolean {
  if (manuallyRenamed) return false;
  if (promptCount === 0) return false;
  return promptCount % AUTO_RENAME_INTERVAL === 0;
}

/**
 * Extract the text of recent user prompts from the event store.
 * Returns at most MAX_RECENT_PROMPTS entries.
 */
export function extractRecentPrompts(events: StoredEvent[]): string[] {
  const prompts: string[] = [];
  for (const evt of events) {
    if (evt.type === 'user_message' && typeof evt.payload.text === 'string') {
      prompts.push(evt.payload.text);
    }
  }
  // Keep only the most recent prompts
  if (prompts.length > MAX_RECENT_PROMPTS) {
    return prompts.slice(-MAX_RECENT_PROMPTS);
  }
  return prompts;
}

/**
 * Generate a short session name from recent prompts using keyword extraction.
 * This is a lightweight heuristic — no API call needed.
 */
export function generateSessionName(prompts: string[]): string {
  if (prompts.length === 0) return '';

  // Collect word frequencies across all prompts
  const freq = new Map<string, number>();
  for (const prompt of prompts) {
    const words = prompt
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

    // Use a set per prompt to avoid over-counting repeated words in a single prompt
    const seen = new Set<string>();
    for (const word of words) {
      if (!seen.has(word)) {
        freq.set(word, (freq.get(word) || 0) + 1);
        seen.add(word);
      }
    }
  }

  // Sort by frequency (descending), then alphabetically for stability
  const sorted = [...freq.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });

  // Take top words and capitalize
  const topWords = sorted.slice(0, 6).map(([word]) => word.charAt(0).toUpperCase() + word.slice(1));

  if (topWords.length === 0) return '';

  const name = topWords.join(' ');
  if (name.length > MAX_NAME_LENGTH) {
    return name.slice(0, MAX_NAME_LENGTH).trim();
  }
  return name;
}
