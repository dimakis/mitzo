/** Canonical display/digest formatting only. These functions confer no account,
 * provider or model authority; callers must retain the actual original caps. */
export function stagingApiChargedAccount(scope: {
  organizationId: string;
  projectId: string;
}): string {
  return `openai/${scope.organizationId}/${scope.projectId}`;
}
export function stagingVertexChargedAccount(scope: {
  principal: string;
  projectId: string;
  region: 'global';
}): string {
  return `${scope.principal}@${scope.projectId}/${scope.region}`;
}
