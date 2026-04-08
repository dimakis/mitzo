import Anthropic from '@anthropic-ai/sdk';
import type { StoredEvent } from './event-store.js';
import { createLogger } from './logger.js';

const log = createLogger('auto-rename');

/** Every Nth user prompt triggers an auto-rename. */
export const AUTO_RENAME_INTERVAL = 2;

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
 * Create an Anthropic client instance. Exported so tests can mock it.
 */
export function createAnthropicClient(): Anthropic {
  return new Anthropic();
}

/** Module-level client factory — reassignable for testing. */
let clientFactory: () => Anthropic = createAnthropicClient;

/**
 * Override the client factory (used by tests to inject mocks).
 */
export function setClientFactory(factory: () => Anthropic): void {
  clientFactory = factory;
}

/**
 * Reset the client factory to the default (used by tests for cleanup).
 */
export function resetClientFactory(): void {
  clientFactory = createAnthropicClient;
}

/**
 * Check whether an auto-rename should fire for the given prompt count.
 */
export function shouldAutoRename(promptCount: number, manuallyRenamed: boolean): boolean {
  if (manuallyRenamed) return false;
  if (promptCount === 0) return false;
  if (promptCount === 1) return true;
  if (promptCount <= 2) return false;
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
 * This is the fallback when the LLM call fails.
 */
export function generateSessionNameFallback(prompts: string[]): string {
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

/**
 * Generate a short session name using Claude Haiku.
 * Falls back to keyword extraction if the API call fails.
 */
export async function generateSessionName(prompts: string[]): Promise<string> {
  if (prompts.length === 0) return '';

  try {
    const client = clientFactory();
    const response = await client.messages.create(
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 20,
        system:
          'Generate a 3-6 word title for this chat session. Be specific and descriptive. Return only the title, nothing else.',
        messages: [
          {
            role: 'user',
            content: prompts.join('\n'),
          },
        ],
      },
      { timeout: 5000 },
    );

    const textBlock = response.content.find((b) => b.type === 'text');
    const name = textBlock?.text?.trim() ?? '';

    if (name && name.length <= MAX_NAME_LENGTH) {
      return name;
    }
    if (name) {
      return name.slice(0, MAX_NAME_LENGTH).trim();
    }
  } catch (err: unknown) {
    log.warn('Haiku auto-rename failed, falling back to keyword extraction', {
      error: err instanceof Error ? err.message : 'unknown',
    });
  }

  return generateSessionNameFallback(prompts);
}
