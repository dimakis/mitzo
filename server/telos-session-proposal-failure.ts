/** Shared by the host adapter and lightweight MCP transport. Causes stay local;
 * public diagnostics must never serialize provider, source or credential data. */
type Stage = 'proposal' | 'delivery';
const causes = new Map<string, unknown>();

export function telosSessionProposalFailure(requestId: string, stage: Stage = 'proposal') {
  return causes.get(`${stage}:${requestId}`);
}

export function retainTelosSessionProposalFailure(requestId: string, stage: Stage, cause: unknown) {
  const key = `${stage}:${requestId}`;
  causes.delete(key);
  causes.set(key, cause);
  while (causes.size > 32) causes.delete(causes.keys().next().value!);
}
