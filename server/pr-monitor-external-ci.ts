import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { PrMonitorFinding } from '@mitzo/protocol';
import type { GitHubReadResponse } from './github-read-response.js';

const number = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const decimal = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .max(16);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const timestamp = z.iso.datetime();
const state = z.enum(['pending', 'passed', 'failed', 'cancelled', 'neutral', 'skipped']);
const common = {
  id: decimal,
  headSha: sha,
  slot: z.string().max(200),
  status: state,
  completedAt: timestamp.nullable(),
};
/** Internal read-port variants. External producers never acquire Actions IDs or
 * attempts. Public findings retain the existing exact-reference contract. */
export const externalCiSchema = z.discriminatedUnion('source', [
  z.object({
    ...common,
    source: z.literal('check'),
    appId: decimal,
    suiteId: decimal,
    startedAt: timestamp.nullable(),
    referenceUrl: z.string().nullable(),
  }),
  z.object({ ...common, source: z.literal('status'), creatorId: decimal, createdAt: timestamp }),
]);
export type ExternalCi = z.infer<typeof externalCiSchema>;
const checkSchema = z.object({
  id: number,
  name: z.string().min(1).max(1024),
  head_sha: sha,
  app: z.object({ id: number }),
  check_suite: z.object({ id: number }),
  url: z.string(),
  html_url: z.string().nullable(),
  status: z.enum(['queued', 'waiting', 'requested', 'pending', 'in_progress', 'completed']),
  conclusion: z.string().nullable(),
  started_at: timestamp.nullable(),
  completed_at: timestamp.nullable(),
});
const statusSchema = z.object({
  id: number,
  context: z.string().min(1).max(1024),
  state: z.enum(['error', 'failure', 'pending', 'success']),
  url: z.string(),
  creator: z.object({ id: number }),
  created_at: timestamp,
  updated_at: timestamp,
});
const hash = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

/** Validate the API's exact repository/record association; do not follow URLs. */
export function checkRunIdFromUrl(value: string, root: string): string {
  const prefix = `https://api.github.com${root}/check-runs/`;
  if (!value.startsWith(prefix)) throw Error('incomplete');
  const id = value.slice(prefix.length);
  if (!decimal.safeParse(id).success || !Number.isSafeInteger(Number(id)))
    throw Error('incomplete');
  return id;
}
function checkReference(value: string | null, root: string, id: number): string | null {
  const canonical = `https://github.com${root.slice('/repos'.length)}/runs/${id}`;
  // GitHub adds this navigation-only query to check html_url. No producer URL,
  // arbitrary query, fragment, redirect or external details_url is accepted.
  return value === canonical || value === `${canonical}?check_suite_focus=true` ? canonical : null;
}
function checkState(status: string, conclusion: string | null): z.infer<typeof state> {
  if (status !== 'completed') {
    if (conclusion !== null) throw Error('incomplete');
    return 'pending';
  }
  switch (conclusion) {
    case 'success':
      return 'passed';
    case 'failure':
    case 'timed_out':
    case 'action_required':
    case 'startup_failure':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'neutral':
      return 'neutral';
    case 'skipped':
      return 'skipped';
    default:
      throw Error('incomplete');
  }
}

/** Uses only the injected authenticated, charged, bounded GET owner. The exact
 * SHA is selected by the observer's opening/closing PR fence. No new client,
 * quota owner, target/details URL fetch, pagination-link following or timer. */
export async function readPrMonitorExternalCi(options: {
  root: string;
  headSha: string;
  page: number;
  get(endpoint: string): Promise<GitHubReadResponse>;
}): Promise<GitHubReadResponse> {
  const { root, headSha, page, get } = options;
  const commit = `${root}/commits/${headSha}`;
  if (page === 1) {
    const response = await get(`${commit}/check-suites?per_page=1&page=1`);
    if (response.status !== 200) return response;
    const suites = z
      .object({
        total_count: z.number().int().nonnegative(),
        check_suites: z.array(z.unknown()).max(1),
      })
      .parse(response.data);
    // The commit check-runs endpoint silently caps the source at 1000 suites.
    // Do not claim completeness at that boundary or expand the HTTP budget.
    if (suites.total_count >= 1000) throw Error('incomplete');
  }
  const response = await get(`${commit}/check-runs?filter=all&per_page=100&page=${page}`);
  if (response.status !== 200) return response;
  const checks = z
    .object({
      total_count: z.number().int().nonnegative(),
      check_runs: z.array(checkSchema).max(100),
    })
    .parse(response.data);
  if (
    checks.check_runs.length !== Math.min(100, Math.max(0, checks.total_count - (page - 1) * 100))
  )
    throw Error('incomplete');
  const items: ExternalCi[] = checks.check_runs.map((c) => {
    if (c.head_sha !== headSha || checkRunIdFromUrl(c.url, root) !== String(c.id))
      throw Error('incomplete');
    if (c.started_at && c.completed_at && Date.parse(c.completed_at) < Date.parse(c.started_at))
      throw Error('incomplete');
    if (c.status !== 'completed' && c.completed_at !== null) throw Error('incomplete');
    return {
      source: 'check',
      id: String(c.id),
      headSha,
      slot: `check:${hash([c.app.id, c.name])}`,
      appId: String(c.app.id),
      suiteId: String(c.check_suite.id),
      startedAt: c.started_at,
      completedAt: c.completed_at,
      status: checkState(c.status, c.conclusion),
      referenceUrl: checkReference(c.html_url, root, c.id),
    };
  });
  const statusesResponse = await get(`${commit}/statuses?per_page=100&page=${page}`);
  if (statusesResponse.status !== 200) return statusesResponse;
  const statuses = z.array(statusSchema).max(100).parse(statusesResponse.data);
  for (const s of statuses) {
    if (
      s.url !== `https://api.github.com${root}/statuses/${s.id}` ||
      Date.parse(s.updated_at) < Date.parse(s.created_at)
    )
      throw Error('incomplete');
    items.push({
      source: 'status',
      id: String(s.id),
      headSha,
      creatorId: String(s.creator.id),
      slot: `status:${hash([root.toLowerCase(), s.context.toLowerCase()])}`,
      createdAt: s.created_at,
      completedAt: s.state === 'pending' ? null : s.created_at,
      status: s.state === 'success' ? 'passed' : s.state === 'pending' ? 'pending' : 'failed',
    });
  }
  if (items.length > 100) throw Error('incomplete');
  return {
    ...response,
    data: { items, hasNext: checks.total_count > page * 100 || statuses.length === 100 },
  };
}

type ActionCheck = {
  id: string;
  headSha: string;
  checkRunId?: string;
  status: string;
  completedAt: string | null;
};
/** Select latest per producer/source; IDs identify records, never chronology.
 * Null/tied start times cannot establish which distinct check is current. Status
 * creation time is immutable; updated_at and producer-controlled text are not
 * chronology. Explicit Actions mappings are reconciled before name reduction. */
export function latestExternalCi(
  items: ExternalCi[],
  headSha: string,
  actions: ActionCheck[],
): Map<string, ExternalCi> {
  const checks = new Map<string, ExternalCi>();
  const seen = new Set<string>();
  for (const item of items) {
    if (item.headSha !== headSha || seen.has(`${item.source}:${item.id}`))
      throw Error('incomplete');
    seen.add(`${item.source}:${item.id}`);
    if (item.source === 'check') checks.set(item.id, item);
  }
  const mapped = new Set<string>();
  for (const action of actions) {
    if (!action.checkRunId) continue;
    const c = checks.get(action.checkRunId);
    if (
      !c ||
      mapped.has(c.id) ||
      action.headSha !== c.headSha ||
      action.status !== c.status ||
      action.completedAt !== c.completedAt
    )
      throw Error('incomplete');
    mapped.add(c.id);
  }
  const latest = new Map<string, ExternalCi>();
  for (const item of items) {
    if (item.source === 'check' && mapped.has(item.id)) continue;
    const prior = latest.get(item.slot);
    if (!prior) {
      latest.set(item.slot, item);
      continue;
    }
    const revision = item.source === 'check' ? item.startedAt : item.createdAt;
    const priorRevision = prior.source === 'check' ? prior.startedAt : prior.createdAt;
    if (
      !revision ||
      !priorRevision ||
      (Date.parse(revision) === Date.parse(priorRevision) && !isDeepStrictEqual(item, prior))
    )
      throw Error('incomplete');
    if (Date.parse(revision) > Date.parse(priorRevision)) latest.set(item.slot, item);
  }
  return latest;
}

export function externalCiFindings(latest: Map<string, ExternalCi>): PrMonitorFinding[] {
  const findings: PrMonitorFinding[] = [];
  for (const item of latest.values()) {
    if (item.status !== 'failed') continue;
    // Status target_url is producer-controlled and no exact github.com status
    // permalink is supported by the reference contract. Retain diagnostic partial
    // state through the observer; never manufacture an actionable reference.
    if (item.source !== 'check' || !item.referenceUrl || !item.completedAt)
      throw Error('incomplete');
    findings.push({
      kind: 'ci_failure',
      sourceIds: [`check:${item.appId}:${item.id}:${item.completedAt}:failed`],
      summary: 'Current-head CI check failed.',
      references: [{ kind: 'check', id: item.id, url: item.referenceUrl }],
      truncated: false,
    });
  }
  return findings;
}
