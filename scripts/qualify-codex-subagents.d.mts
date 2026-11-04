export interface CodexSubagentContractReport {
  codexCliVersion: string;
  evidence: 'generated_protocol_only';
  modelCalls: 0;
  executionQualified: false;
  threadIdentityFields: string[];
  collaborationItemType: string;
  collaborationIdentityFields: string[];
  collaborationTools: string[];
  controls: Record<string, string[]>;
  dynamicToolIdentityFields: string[];
  remainingChecks: string[];
}
export function qualifyCodexSubagentContract(
  version: string,
  schemas: Record<string, unknown>,
): CodexSubagentContractReport;
export function probeCodexSubagentContract(
  executable: string,
  output: string,
): CodexSubagentContractReport;
