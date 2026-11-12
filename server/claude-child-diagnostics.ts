import type { SubagentDiagnostic } from '@mitzo/protocol';

type Report = (taskId: string, toolId: string, diagnostic: SubagentDiagnostic) => void;
// Feedback only. An observed child never obtains execution or transcript authority.
const reporters = new WeakMap<object, Report>();

export function bindClaudeChildDiagnostic(owner: object, report: Report): () => void {
  reporters.set(owner, report);
  return () => {
    if (reporters.get(owner) === report) reporters.delete(owner);
  };
}

export function reportClaudeChildDiagnostic(
  owner: object,
  taskId: string,
  toolId: string,
  diagnostic: SubagentDiagnostic,
): boolean {
  const report = reporters.get(owner);
  if (!report) return false;
  report(taskId, toolId, diagnostic);
  return true;
}
