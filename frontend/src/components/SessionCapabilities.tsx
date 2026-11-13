import type { RuntimeReadiness, SessionAccessEvidence } from '@mitzo/protocol';

const unknownReasons = {
  session_unavailable: 'Unknown — current session evidence is unavailable.',
  not_observed: 'Unknown — this runtime has not supplied capability observations.',
  invalid_evidence: 'Unknown — runtime evidence could not be validated.',
  scope_mismatch: 'Unknown — evidence does not match the current session or runtime.',
  owner_unavailable: 'Unknown — the runtime owner could not be checked.',
};
const supportLabels = {
  supported: 'Supported by route; execution not verified',
  unsupported: 'Unsupported on this route',
  excluded: 'Not selected by this agent profile',
  restricted: 'Blocked by the active skill restriction',
};
const factLabels = {
  yes: 'Yes',
  no: 'No',
  unknown: 'Unknown',
  granted: 'Granted',
  denied: 'Denied',
  attached: 'Attached',
  detached: 'Detached',
  allowed: 'Allowed',
  starting: 'Starting',
  ready: 'Ready',
  unavailable: 'Unavailable',
  available: 'Available',
  missing: 'Missing',
};
type Capabilities = RuntimeReadiness['capabilities'];
type Observation = Extract<Capabilities, { evidence: unknown }>['evidence'];
type Verification = Observation['services'][number]['operations'][number]['verification'];
function verificationLabel(value: Verification, stale: boolean, now: number) {
  if (value.state === 'unknown') return 'Not verified';
  if (value.state === 'stale' || value.expiresAt <= now)
    return `Verification expired — earlier result: ${value.state === 'stale' ? 'not retained' : value.state}`;
  return stale
    ? `Earlier result: ${value.state}`
    : value.state === 'succeeded'
      ? 'Succeeded'
      : 'Failed';
}
const time = (value: number) => new Date(value).toLocaleString();

/** Display only. The readiness owner has already validated identity and evidence.
 * Client time can expire observations; it can never promote a stale result.
 */
export function SessionCapabilities({
  evidence,
  stale,
  now,
}: {
  evidence: SessionAccessEvidence | null;
  stale: boolean;
  now: number;
}) {
  const readiness = evidence?.readiness;
  const capabilities = readiness?.capabilities;
  const measured =
    capabilities && capabilities.state !== 'unknown' ? capabilities.evidence : undefined;
  const expired = !!measured && (capabilities?.state === 'stale' || measured.expiresAt <= now);
  const earlier = stale || expired;
  const support = evidence?.helperSupport;
  const groups = new Map<
    string,
    Extract<NonNullable<typeof support>, { state: 'configured' }>['tools']
  >();
  if (support?.state === 'configured')
    for (const tool of support.tools) {
      const group = groups.get(tool.source) ?? [];
      group.push(tool);
      groups.set(tool.source, group);
    }
  return (
    <details className="session-capabilities">
      <summary>
        Capabilities<span className="workspace-muted">Route support and verification</span>
      </summary>
      <p className="workspace-muted">
        Configured support does not verify execution. Permissions and service access are checked for
        each operation.
      </p>
      {stale && (
        <p role="status">
          Earlier capability observation — refresh Access to check current support.
        </p>
      )}
      <dl className="access-resource-facts">
        <div>
          <dt>Configured runtime</dt>
          <dd>
            {readiness?.execution.state === 'configured'
              ? `${readiness.execution.binding.harness.implementation === 'claude-sdk' ? 'Claude' : readiness.execution.binding.harness.implementation === 'codex' ? 'Codex' : readiness.execution.binding.harness.implementation} · ${readiness.execution.binding.execution.location === 'local' ? 'Local Mac' : 'OpenShell'}`
              : 'Unknown — runtime configuration is unavailable.'}
          </dd>
        </div>
        <div>
          <dt>Runtime observations</dt>
          <dd>
            {measured ? (
              <>
                {expired
                  ? 'Capability observation expired — refresh Access.'
                  : stale
                    ? 'Earlier observation retained.'
                    : 'Scoped runtime observation'}
                <p className="workspace-muted">
                  Observed {time(measured.observedAt)} · Expires {time(measured.expiresAt)}
                </p>
              </>
            ) : capabilities?.state === 'unknown' ? (
              unknownReasons[capabilities.reason]
            ) : (
              'Unknown — this runtime has not supplied capability observations.'
            )}
          </dd>
        </div>
      </dl>
      {support?.state === 'configured' ? (
        <>
          <p className="workspace-muted">
            Mitzo helper support follows this route and its captured agent profile. Native engine
            tools and configured MCP tools are not inventoried here.
          </p>
          {[...groups].map(([source, tools]) => (
            <details className="session-capability-group" key={source}>
              <summary>
                {source}
                <span className="workspace-muted">
                  {tools.filter((tool) => tool.state === 'supported').length} of {tools.length}{' '}
                  supported by route
                </span>
              </summary>
              <dl className="access-resource-facts">
                {tools.map((tool) => (
                  <div key={tool.name}>
                    <dt>{tool.name}</dt>
                    <dd>
                      <span>{supportLabels[tool.state]}</span>
                      <p className="workspace-muted">{tool.requirement}</p>
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          ))}
        </>
      ) : (
        <p>
          Unknown —{' '}
          {support?.state === 'unknown' && support.reason === 'route_unqualified'
            ? 'helper support has not been qualified for this route.'
            : 'the current runtime and agent selection could not be checked.'}
        </p>
      )}
      {measured && (
        <>
          <dl className="access-resource-facts">
            <div>
              <dt>Process</dt>
              <dd>
                {earlier ? 'Earlier observation: ' : ''}
                {factLabels[measured.process]}
              </dd>
            </div>
            {measured.tools.map((tool) => (
              <div key={tool.name}>
                <dt>{tool.name}</dt>
                <dd>
                  {earlier ? 'Earlier observation: ' : ''}
                  {factLabels[tool.state]}
                </dd>
              </div>
            ))}
            {measured.executables.map((executable) => (
              <div key={executable.command}>
                <dt>{executable.command}</dt>
                <dd>
                  {earlier ? 'Earlier observation: ' : ''}
                  {factLabels[executable.state]}
                </dd>
              </div>
            ))}
          </dl>
          {measured.services.map((service) => (
            <details className="session-capability-group" key={service.id}>
              <summary>
                {service.id}
                <span className="workspace-muted">Operation evidence</span>
              </summary>
              {earlier && <p className="workspace-muted">Earlier service observations</p>}
              <p>Configured: {factLabels[service.configured]}</p>
              <p>
                Approval: {factLabels[service.approval]} · Attachment:{' '}
                {factLabels[service.attachment]}
              </p>
              <dl className="access-resource-facts">
                {service.operations.map((operation) => (
                  <div key={operation.operation}>
                    <dt>{operation.operation}</dt>
                    <dd>
                      {verificationLabel(operation.verification, earlier, now)}
                      <p className="workspace-muted">Policy: {factLabels[operation.policy]}</p>
                      {operation.verification.state !== 'unknown' && (
                        <p className="workspace-muted">
                          Observed {time(operation.verification.observedAt)} · Expires{' '}
                          {time(operation.verification.expiresAt)}
                        </p>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          ))}
        </>
      )}
    </details>
  );
}
