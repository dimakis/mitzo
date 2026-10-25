import { writeFile } from 'node:fs/promises';
import type { createActualApp } from './actual-app.js';
import type { publicationJourney } from './publication-journey.js';
import type { reviewArtifactThenCompleteMilestoneAndOutcome } from './review-completion.js';
type App = Awaited<ReturnType<typeof createActualApp>>;
export interface ColdHandoff {
  initialAppPid: number;
  application: {
    kind: App['kind'];
    root: string;
    token: string;
    connectionIdTransport: string;
    authenticated: { id: string };
  };
  selected: {
    itemId: string;
    taskId: string;
    sessionIds: string[];
    directory: string;
    inode: number;
    report: number[];
    artifact: { id: string; revision: number; sha256: string };
    command: unknown;
    publication?: Awaited<ReturnType<typeof publicationJourney>>;
    canonicalItems: Awaited<
      ReturnType<typeof reviewArtifactThenCompleteMilestoneAndOutcome>
    >[number]['item'][];
  };
  beforeWork: Awaited<ReturnType<App['api']['read']>>;
  sources: Awaited<ReturnType<App['api']['readSource']>>[];
  sessions: NonNullable<ReturnType<App['chat']['eventStore']['getSession']>>[];
  environment: Record<string, string>;
}
/** Transfer only synthetic data and cleanup responsibility. This is never
 * command/permission/publication authority. The cold App authenticates the real
 * original signed token and uses its own original owners. */
export async function prepareColdHandoff(
  app: App,
  path: string,
  selected: Omit<ColdHandoff['selected'], 'report'> & { report: Uint8Array },
) {
  const beforeWork = await app.api.read(selected.itemId);
  const sources = await Promise.all(
    beforeWork.sources.map((source) => app.api.readSource(selected.itemId, source.snapshotId)),
  );
  const sessions = selected.sessionIds.map((id) => app.chat.eventStore.getSession(id)!);
  const environment: Record<string, string> = {};
  for (const key of [
    'TMPDIR',
    'REPO_PATH',
    'TELOS_DB_PATH',
    'MITZO_CODEX_PRIVATE_DIR',
    'MITZO_ORDINARY_TASK_ROOT',
    'MITZO_ACCOUNT_PROFILES_FILE',
    'MITZO_OPENAI_ACCOUNT_ENROLLMENT_DB',
    'MITZO_CODEX_ENABLED',
    'MITZO_ORDINARY_LOCAL_CODEX_ENABLED',
    'MITZO_REPOSITORY_WORKSPACES_ENABLED',
    'MITZO_ORDINARY_LOCAL_CODEX_NATIVE_FILE',
    'MITZO_ORDINARY_LOCAL_CODEX_TARGET_FILE',
    'MITZO_MODEL_LIMITS_CATALOG_FILE',
    'MGMT_MANUAL_ITEMS_PATH',
    'PYTHONPATH',
    'PYTHONNOUSERSITE',
    'PYTHONDONTWRITEBYTECODE',
  ])
    if (process.env[key] !== undefined) environment[key] = process.env[key]!;
  const data: ColdHandoff = {
    initialAppPid: process.pid,
    application: {
      kind: app.kind,
      root: app.root,
      token: app.token,
      connectionIdTransport: app.connectionIdTransport,
      authenticated: { id: app.authenticated.id },
    },
    selected: { ...selected, report: Array.from(selected.report) },
    beforeWork,
    sources,
    sessions,
    environment,
  };
  await writeFile(path, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
  app.transferPrivateRootCleanup();
  await app.record('initial-app-cold-handoff-prepared-before-process-reaping', {
    pid: process.pid,
    root: app.root,
    itemId: selected.itemId,
    taskId: selected.taskId,
    notYetCold: true,
  });
}
