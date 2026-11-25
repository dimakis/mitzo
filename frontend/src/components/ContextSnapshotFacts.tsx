import { useEffect, useId, useState, type ReactNode } from 'react';
import type { ContextMeasurement } from '@mitzo/protocol';
import { MotionPresence } from './MotionPresence';

const tokens = (value: number | undefined) =>
  value === undefined ? 'Unknown' : `${value.toLocaleString()} tokens`;
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="context-snapshot-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function ContextSnapshotFacts({ snapshot }: { snapshot: ContextMeasurement }) {
  const [sources, setSources] = useState(false);
  const [shown, setShown] = useState(20);
  const [, tick] = useState(0);
  const sourcesId = useId();
  const expiresAt = snapshot.freshness.expiresAt;
  useEffect(() => {
    if (expiresAt === undefined || expiresAt <= Date.now()) return;
    const timer = setTimeout(
      () => tick((value) => value + 1),
      Math.min(expiresAt - Date.now() + 1, 2 ** 31 - 1),
    );
    return () => clearTimeout(timer);
  }, [expiresAt]);
  const expired = expiresAt !== undefined && expiresAt <= Date.now();
  const freshness = expired ? 'stale' : snapshot.freshness.state;
  const capacityStale = snapshot.capacity.stale || freshness !== 'current';
  const usage = snapshot.requestUsage;
  const occupancy =
    snapshot.measurement.basis === 'current-context-estimate' && snapshot.usedTokens !== undefined;
  const observed = new Date(snapshot.observedAt);
  // The schema accepts safe integer timestamps beyond Date's supported range.
  const validDate = Number.isFinite(observed.getTime());
  return (
    <>
      <dl className="context-snapshot-facts">
        <Fact label="Occupancy">
          {occupancy ? `${tokens(snapshot.usedTokens)} (estimated)` : 'Occupancy unknown'}
        </Fact>
        <Fact label="Freshness">
          {freshness}
          {expired ? ' · observation expired' : ''}
        </Fact>
        <Fact label="Observation time">
          {validDate ? (
            <time dateTime={observed.toISOString()}>{observed.toLocaleString()}</time>
          ) : (
            'Unavailable timestamp'
          )}
        </Fact>
        <Fact label="Measurement">
          {snapshot.measurement.basis} · {snapshot.measurement.assurance}
        </Fact>
        <Fact label="Method">{snapshot.measurement.method}</Fact>
        <Fact label="Model">{snapshot.binding.model}</Fact>
        <Fact label="Runtime">
          {snapshot.binding.engine} · {snapshot.binding.placement}
        </Fact>
      </dl>
      <p className="context-snapshot-note">
        Observation time is the host receipt time, not the time of the provider’s last request.
      </p>
      {usage && (
        <section aria-label="Latest request usage">
          <h3>Latest request usage</h3>
          <p>
            Request usage does not measure current occupancy. Cached input is already included in
            input; reasoning output is already included in output.
          </p>
          <dl className="context-snapshot-facts">
            <Fact label="Request total">{tokens(usage.totalTokens)}</Fact>
            <Fact label="Input">{tokens(usage.inputTokens)}</Fact>
            <Fact label="Cached input (subset)">{tokens(usage.cachedInputTokens)}</Fact>
            <Fact label="Output">{tokens(usage.outputTokens)}</Fact>
            <Fact label="Reasoning output (subset)">{tokens(usage.reasoningOutputTokens)}</Fact>
          </dl>
        </section>
      )}
      <section aria-label="Capacity observations">
        <h3>Capacity observations</h3>
        <p>
          {capacityStale
            ? 'Capacity is stale or unverified; current capacity is unknown.'
            : 'Reported windows are separate from model limits. Missing capacity is unknown.'}{' '}
          Free space is never calculated from request usage.
        </p>
        <dl className="context-snapshot-facts">
          <Fact label="Resolved window">
            {tokens(snapshot.capacity.compactionWindowTokens)}
            {capacityStale ? ' (stale)' : ''}
          </Fact>
          <Fact label="Usable window">
            {tokens(snapshot.capacity.usableWindowTokens)}
            {capacityStale ? ' (stale)' : ''}
          </Fact>
          <Fact label="Reported free space">
            {tokens(snapshot.capacity.freeTokens)}
            {capacityStale ? ' (stale)' : ''}
          </Fact>
          <Fact label="Compaction reserve">
            {tokens(snapshot.capacity.bufferTokens)}
            {capacityStale ? ' (stale)' : ''}
          </Fact>
          <Fact label="Window kind">{snapshot.capacity.kind}</Fact>
          <Fact label="Capacity source">{snapshot.capacity.source}</Fact>
          {snapshot.capacity.modelLimits && (
            <>
              <Fact label="Model context limit">
                {tokens(snapshot.capacity.modelLimits.contextWindow)}
              </Fact>
              <Fact label="Model input limit">
                {tokens(snapshot.capacity.modelLimits.inputTokenLimit)}
              </Fact>
              <Fact label="Model output limit">
                {tokens(snapshot.capacity.modelLimits.outputTokenLimit)}
              </Fact>
              <Fact label="Model limit freshness">
                {snapshot.capacity.modelLimits.stale ||
                capacityStale ||
                (snapshot.capacity.modelLimits.expiresAt !== undefined &&
                  snapshot.capacity.modelLimits.expiresAt <= Date.now())
                  ? 'Stale / unverified'
                  : snapshot.capacity.modelLimits.source === 'unknown'
                    ? 'Unknown'
                    : 'Current'}
              </Fact>
            </>
          )}
        </dl>
      </section>
      <section aria-label="Context categories">
        <h3>Categories</h3>
        <p>
          Used content, free space and compaction reserve are separate. Deferred tools are outside
          the window and do not add to occupied context. Unknown kinds are not included in totals.
        </p>
        {!snapshot.categories.length ? (
          <p>No category breakdown reported.</p>
        ) : (
          <dl className="context-snapshot-facts">
            {snapshot.categories.map((row) => (
              <Fact key={row.key} label={row.label}>
                {tokens(row.tokens)}
                <small>
                  {row.kind} · {row.assurance}
                </small>
              </Fact>
            ))}
          </dl>
        )}
        <dl className="context-snapshot-facts">
          <Fact label="Reconciliation">{snapshot.reconciliation.status}</Fact>
          <Fact label="Residual">
            {snapshot.reconciliation.residualTokens === undefined
              ? 'Unknown'
              : `${snapshot.reconciliation.residualTokens > 0 ? '+' : ''}${tokens(snapshot.reconciliation.residualTokens)}`}
          </Fact>
        </dl>
        <p className="context-snapshot-note">
          Residual is the reported total minus known used categories. Disagreement is preserved,
          including negative values; it is not distributed across rows.
        </p>
      </section>
      <button
        type="button"
        className="home-secondary"
        aria-expanded={sources}
        aria-controls={sourcesId}
        onClick={() => setSources((value) => !value)}
      >
        Source contributions
      </button>
      <MotionPresence open={sources} kind="disclosure">
        <section id={sourcesId} aria-label="Source contributions">
          <p>
            Contributions are not additional usage. Overlap and unknown relationships cannot be
            added together; inventory does not prove retained occupancy.
          </p>
          <p>
            Source opening is unavailable. References are opaque and local to this snapshot; no
            authorized source resolver is installed.
          </p>
          {!snapshot.contributions.length ? (
            <p>No contributions reported.</p>
          ) : (
            <dl className="context-snapshot-facts">
              {snapshot.contributions.slice(0, shown).map((row, index) => (
                <Fact key={row.id} label={`Contribution ${index + 1}`}>
                  {tokens(row.tokens)}
                  <small>
                    {row.relation} · {row.assurance}
                  </small>
                  {row.categoryKey && (
                    <small>
                      {
                        snapshot.categories.find((category) => category.key === row.categoryKey)
                          ?.label
                      }
                    </small>
                  )}
                </Fact>
              ))}
            </dl>
          )}
          {shown < snapshot.contributions.length && (
            <button
              type="button"
              className="home-secondary"
              onClick={() => setShown((value) => value + 20)}
            >
              Show more contributions ({snapshot.contributions.length - shown} remaining)
            </button>
          )}
        </section>
      </MotionPresence>
    </>
  );
}
