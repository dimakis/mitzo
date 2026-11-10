import { approvalPresentation } from '../lib/approval-presentation';
import '../styles/approval-summary.css';
export function ApprovalRequestSummary({
  input,
  toolName,
  description,
}: {
  input: string;
  toolName?: string;
  description?: string;
}) {
  const presentation = approvalPresentation(input, toolName);
  return (
    <>
      {presentation.reason && <p>{presentation.reason}</p>}
      {presentation.facts.length > 0 && (
        <dl className="approval-request-facts">
          {presentation.facts.map((fact, index) => (
            <div key={`${fact.label}:${index}`}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {!presentation.recognized && (
        <p className="workspace-muted">
          Review the request details before allowing this operation.
        </p>
      )}
      <details
        className="approval-request-details perm-banner-details"
        open={!presentation.recognized}
      >
        <summary>Request details</summary>
        {description && <p>{description}</p>}
        <pre className="perm-banner-input">{input}</pre>
      </details>
    </>
  );
}
