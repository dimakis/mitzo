/**
 * ContexGin Goal Registry client.
 *
 * Handles goal auto-creation on session start and usage reporting on session end.
 * All calls are fire-and-forget — ContexGin being down never blocks Mitzo.
 */
import { createLogger } from './logger.js';

const log = createLogger('goal-client');

const CONTEXGIN_URL = process.env.CONTEXGIN_URL || 'http://localhost:8321';

// ── Types ──────────────────────────────────────────────────────

interface GoalResponse {
  id: string;
  title: string;
  status: string;
}

interface UsageContributionInput {
  source: string;
  sourceId: string;
  sourceLabel?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  turns?: number;
  toolCalls?: number;
  durationMs?: number;
  durationApiMs?: number;
  metadata?: Record<string, unknown>;
}

// ── Health check ───────────────────────────────────────────────

let available: boolean | null = null;
let lastCheck = 0;
const CHECK_INTERVAL_MS = 30_000;

/** Reset cached availability state (for testing). */
export function resetAvailability(): void {
  available = null;
  lastCheck = 0;
}

async function isAvailable(): Promise<boolean> {
  const now = Date.now();
  if (available !== null && now - lastCheck < CHECK_INTERVAL_MS) {
    return available;
  }
  try {
    const res = await fetch(`${CONTEXGIN_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    available = res.ok;
  } catch {
    available = false;
  }
  lastCheck = now;
  return available;
}

// ── Goal creation ──────────────────────────────────────────────

/**
 * Create a goal in the ContexGin Goal Registry.
 * Returns the goal ID, or null if ContexGin is unreachable.
 */
export async function createGoal(
  title: string,
  opts?: { description?: string; contextCondition?: string },
): Promise<string | null> {
  if (!(await isAvailable())) {
    log.debug('ContexGin unavailable, skipping goal creation');
    return null;
  }

  try {
    const res = await fetch(`${CONTEXGIN_URL}/api/goals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        description: opts?.description,
        contextCondition: opts?.contextCondition,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      log.warn('goal creation failed', { status: res.status });
      return null;
    }

    const goal = (await res.json()) as GoalResponse;
    log.info('goal created', { goalId: goal.id, title: goal.title });
    return goal.id;
  } catch (err: unknown) {
    log.warn('goal creation error', { error: err instanceof Error ? err.message : String(err) });
    available = false;
    return null;
  }
}

// ── Usage reporting ────────────────────────────────────────────

/**
 * Report token usage to the Goal Registry as a contribution.
 * Fire-and-forget — errors are logged but never thrown.
 */
export async function reportUsage(
  goalId: string,
  contribution: UsageContributionInput,
): Promise<void> {
  if (!(await isAvailable())) {
    log.debug('ContexGin unavailable, skipping usage report');
    return;
  }

  try {
    const res = await fetch(
      `${CONTEXGIN_URL}/api/goals/${encodeURIComponent(goalId)}/contributions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(contribution),
        signal: AbortSignal.timeout(5000),
      },
    );

    if (!res.ok) {
      log.warn('usage report failed', { goalId, status: res.status });
      return;
    }

    log.info('usage reported', { goalId, source: contribution.source });
  } catch (err: unknown) {
    log.warn('usage report error', {
      goalId,
      error: err instanceof Error ? err.message : String(err),
    });
    available = false;
  }
}

// ── Goal title derivation ──────────────────────────────────────

/**
 * Derive a short goal title from the initial prompt.
 * Truncates to first sentence or 80 chars, whichever is shorter.
 */
export function deriveGoalTitle(prompt: string): string {
  const cleaned = prompt.replace(/\s+/g, ' ').trim();
  // First sentence (match punctuation followed by space or end of string)
  const sentenceEnd = cleaned.search(/[.!?](\s|$)/);
  const firstSentence = sentenceEnd > 0 ? cleaned.slice(0, sentenceEnd + 1) : cleaned;
  // Cap at 80 chars
  if (firstSentence.length <= 80) return firstSentence;
  return firstSentence.slice(0, 77) + '...';
}
