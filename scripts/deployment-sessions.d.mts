import type { EventStore } from '@mitzo/protocol/event-store';
export type DeploymentAction =
  | 'prepare'
  | 'activate'
  | 'health'
  | 'resume'
  | 'rollback'
  | 'reauthorize'
  | 'reconcile'
  | 'cancel';
export function deploymentBase(raw: string): string;
export function reconcileDeployment(options: {
  action: DeploymentAction;
  targetCommit?: string;
  sessionId?: string;
  statePath: string;
  tokenPath: string;
  base?: string;
  fetcher?: (url: string, input: RequestInit) => Promise<Pick<Response, 'ok' | 'json'>>;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}): Promise<ReturnType<EventStore['deployment']['get']>>;
