import { useContext, useState } from 'react';
import type { TelosWorkControlView } from '@mitzo/protocol';
import type { TelosChatRoute } from '../hooks/useTelosChatRoute';
import { useTelosWorkControls } from '../hooks/useTelosWorkControls';
import { findInTree, useTodoData } from '../hooks/useTodoData';
import { useTelosRecords } from '../hooks/useTelosRecords';
import { TelosChatTreeContext } from '../lib/telos-chat-tree-context';
import './TelosWorkControls.css';

const scopes = {
  publication: 'Publishing to shared main',
  new_worker_dispatch: 'New worker dispatch',
  safe_point: 'Stop at a safe point',
};
const stages = {
  requested: 'Requested',
  acknowledged: 'Acknowledged',
  applied: 'Applied',
  released: 'Released',
};
const count = (n: number) =>
  ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][n] ??
  String(n);
type Data = NonNullable<TelosChatRoute['data']>;
export function TelosWorkControls({
  data,
  conversationId,
}: {
  data: Data | null;
  conversationId: string | null;
}) {
  if (!data || !conversationId) return null;
  const current = data.work.assignments.some(
    (value) =>
      ['lead', 'worker'].includes(value.role) &&
      value.conversation.namespace === 'mitzo' &&
      value.conversation.conversationId === conversationId,
  );
  const legacyWorker =
    data.work.kind === 'work_item' &&
    !data.work.assignments.some((value) => value.role === 'worker') &&
    data.work.attempts.at(-1)?.workerConversationId === conversationId;
  if (!current && !legacyWorker) return null;
  return (
    <BoundControls
      key={`${data.itemId}:${conversationId}`}
      data={data}
      conversationId={conversationId}
    />
  );
}
function BoundControls({ data, conversationId }: { data: Data; conversationId: string }) {
  const state = useTelosWorkControls(data.itemId, data.refreshKey);
  const inspectTree = useContext(TelosChatTreeContext);
  const coordinator =
    data.record.kind === 'coordinator' &&
    data.work.kind === 'coordinator' &&
    data.work.assignments.some(
      (value) =>
        value.role === 'lead' &&
        value.conversation.namespace === 'mitzo' &&
        value.conversation.conversationId === conversationId,
    );
  const canOperate = coordinator && data.workCurrent;
  const collection = useTodoData(undefined, data.itemId);
  const scopeNode = coordinator ? findInTree(collection.items, data.itemId) : undefined;
  const attachedIds = scopeNode?.children.map((value) => value.id) ?? [];
  const attached = useTelosRecords(coordinator ? attachedIds : [], data.refreshKey);
  const ids = new Set<string>();
  for (const value of state.controls) {
    ids.add(value.coordinatorItemId);
    if (value.priorityItemId) ids.add(value.priorityItemId);
    for (const target of value.targets) {
      ids.add(target.itemId);
      for (const worker of target.workers) ids.add(worker.itemId);
    }
  }
  ids.delete(data.itemId);
  for (const id of attachedIds) ids.delete(id);
  const related = useTelosRecords([...ids], data.refreshKey);
  const records = [data.record, ...attached.records, ...related.records];
  const name = (id: string) =>
    records.find((value) => value.itemId === id)?.summary ?? 'Work title unavailable';
  const children = attached.records.filter(
    (value) =>
      value.parentId === data.itemId && (value.kind === 'outcome' || value.kind === 'coordinator'),
  );
  const scopeUnavailable =
    !!collection.error || (!collection.loading && !scopeNode) || attached.unavailable.length > 0;
  const ready =
    canOperate &&
    state.current &&
    !collection.loading &&
    !collection.refreshing &&
    !scopeUnavailable &&
    !attached.loading;
  const ownControls = state.controls.filter((value) => value.coordinatorItemId === data.itemId);
  const hasActiveControl = ownControls.some((value) => value.stage !== 'released');
  const [priority, setPriority] = useState('');
  const [scope, setScope] = useState<TelosWorkControlView['scope']>('publication');
  const targets = children.filter((value) => value.itemId !== priority);
  const canRequest =
    coordinator &&
    ready &&
    children.some((value) => value.itemId === priority) &&
    targets.length > 0 &&
    !state.busy &&
    !state.pending;
  const visible = state.controls.filter(
    (value) =>
      value.coordinatorItemId === data.itemId ||
      value.targets.some(
        (target) =>
          target.itemId === data.itemId ||
          target.workers.some((worker) => worker.itemId === data.itemId),
      ),
  );
  if (!coordinator && state.current && visible.length === 0 && !state.error) return null;
  return (
    <section
      className="telos-work-controls"
      aria-label={coordinator ? 'Coordinator controls' : 'Scoped coordination receipt'}
    >
      {coordinator && (
        <>
          <h3>Coordinate outcome leads</h3>
          <p>Choose the highest-priority outcome and the scope for the other attached leads.</p>
        </>
      )}
      {coordinator && !data.workCurrent && (
        <p role="status">
          Refreshing current work role. Hold controls are unavailable until it is confirmed.
        </p>
      )}
      {!state.current && (
        <p role="status">
          {state.controls.length
            ? 'Refreshing coordination receipts…'
            : 'Loading coordination receipts…'}
        </p>
      )}
      {state.error && (
        <div role="alert">
          <p>{state.error}</p>
          <button
            onClick={() => {
              state.refresh();
              collection.refresh();
              attached.refresh();
              related.refresh();
            }}
            disabled={state.busy}
          >
            Refresh receipts
          </button>
        </div>
      )}
      {coordinator && !hasActiveControl && (
        <>
          <fieldset disabled={!ready || state.busy || !!state.pending}>
            <legend>Which outcome is highest priority?</legend>
            <div className="telos-control-actions">
              {children.map((value) => (
                <button
                  key={value.itemId}
                  aria-pressed={priority === value.itemId}
                  onClick={() => setPriority(value.itemId)}
                >
                  {value.summary}
                </button>
              ))}
            </div>
            {(!ready || children.length === 0) && (
              <p>
                {collection.error ||
                attached.unavailable.length ||
                (!collection.loading && !scopeNode)
                  ? 'Attached outcome scope unavailable. Refresh before sending a hold.'
                  : attached.loading || collection.loading || collection.refreshing
                    ? 'Loading attached outcomes…'
                    : 'No directly attached outcomes available.'}
              </p>
            )}
            <label>
              Hold scope
              <select
                aria-label="Hold scope"
                value={scope}
                onChange={(event) => setScope(event.target.value as typeof scope)}
              >
                {Object.entries(scopes).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <p>
              Each lead propagates this scope to its workers. Acknowledgements distinguish a request
              from an applied hold.
            </p>
            <button
              disabled={!canRequest}
              onClick={() => {
                if (canRequest)
                  void state.send({
                    operation: 'request',
                    coordinatorItemId: data.itemId,
                    priorityItemId: priority,
                    targetItemIds: targets.map((value) => value.itemId),
                    scope,
                  });
              }}
            >
              Send hold to {count(targets.length)} {targets.length === 1 ? 'lead' : 'leads'}
            </button>
          </fieldset>
        </>
      )}
      {coordinator && scopeUnavailable && (
        <button
          disabled={state.busy}
          onClick={() => {
            collection.refresh();
            attached.refresh();
          }}
        >
          Retry attached outcomes
        </button>
      )}
      {state.pending && (
        <div className="telos-control-pending" role="status">
          <p>
            {state.pending.status === 'sending'
              ? 'Recording the control request…'
              : state.pending.status === 'refused'
                ? 'Control request refused. Existing receipts remain unchanged.'
                : 'The original control request is retained for an explicit retry.'}
          </p>
          {coordinator && state.pending.status !== 'sending' && (
            <button
              disabled={!canOperate || !state.current || state.busy}
              onClick={() => {
                if (canOperate) void state.retry();
              }}
            >
              Retry original request
            </button>
          )}
          {state.pending.status === 'refused' && (
            <button onClick={state.discardRefused}>Change request</button>
          )}
        </div>
      )}
      {visible.map((value) => (
        <ControlReceipt
          key={value.controlId}
          value={value}
          itemId={data.itemId}
          coordinator={coordinator && value.coordinatorItemId === data.itemId}
          name={name}
          current={state.current}
          canRelease={canOperate}
          busy={state.busy || !!state.pending}
          read={() => void state.read(value.controlId)}
          release={() => {
            if (canOperate) void state.send({ operation: 'release', controlId: value.controlId });
          }}
        />
      ))}
      {inspectTree && <button onClick={inspectTree}>Inspect work tree</button>}
    </section>
  );
}
function ControlReceipt({
  value,
  itemId,
  coordinator,
  name,
  current,
  canRelease,
  busy,
  read,
  release,
}: {
  value: TelosWorkControlView;
  itemId: string;
  coordinator: boolean;
  name(id: string): string;
  current: boolean;
  canRelease: boolean;
  busy: boolean;
  read(): void;
  release(): void;
}) {
  const rows = new Map<
    string,
    {
      itemId: string;
      conversationId: string | null;
      role: 'lead' | 'worker';
      revision: number;
      stage: 'requested' | 'acknowledged' | 'applied';
    }
  >();
  for (const target of value.targets) {
    if (coordinator || target.itemId === itemId)
      rows.set(`lead:${target.itemId}`, {
        itemId: target.itemId,
        conversationId: target.leadConversationId,
        role: 'lead',
        revision: target.assignmentRevision,
        stage: target.stage,
      });
    for (const worker of target.workers)
      if (coordinator || target.itemId === itemId || worker.itemId === itemId)
        rows.set(`worker:${worker.itemId}`, {
          itemId: worker.itemId,
          conversationId: worker.conversationId,
          role: 'worker',
          revision: worker.assignmentRevision,
          stage: worker.stage,
        });
  }
  const own = [...rows.values()];
  const stage =
    value.stage === 'released'
      ? 'released'
      : coordinator
        ? value.stage
        : own.some((row) => row.stage === 'requested')
          ? 'requested'
          : own.every((row) => row.stage === 'applied')
            ? 'applied'
            : 'acknowledged';
  const title =
    stage === 'released'
      ? value.publicationRevalidation === 'required'
        ? 'Hold released · revalidation required'
        : 'Hold released'
      : stage === 'applied'
        ? 'Hold applied'
        : stage === 'acknowledged'
          ? 'Acknowledged · application pending'
          : 'Hold requested · acknowledgements pending';
  const evidence = value.history.filter(
    (event) => coordinator || own.some((row) => row.itemId === event.itemId),
  );
  return (
    <article
      className="telos-control-receipt"
      aria-label={`${value.origin === 'operator_pause' ? 'Operator pause receipt' : 'Coordination receipt'}: ${scopes[value.scope]}`}
    >
      <h3>{title}</h3>
      <p>Scope · {scopes[value.scope]}</p>
      {value.origin === 'operator_pause' ? (
        <p>Requested by operator</p>
      ) : value.priorityItemId ? (
        <p>Highest priority · {name(value.priorityItemId)}</p>
      ) : null}
      {!current && <p>Current receipt unavailable. Last recorded state is shown.</p>}
      {value.scope === 'publication' && (
        <p>Shared-main publication is unavailable. This receipt records the hold state.</p>
      )}
      {value.publicationRevalidation === 'required' && (
        <p>
          Current-main revalidation is required before publication. Completion is not confirmed by
          this receipt.
        </p>
      )}
      <ul>
        {own.map((row) => (
          <li key={`${row.role}:${row.itemId}`}>
            <strong>{name(row.itemId)}</strong>
            <span>
              {row.role === 'lead' ? 'Lead and child scope' : 'Worker'} ·{' '}
              {row.conversationId ? stages[row.stage] : 'Current recipient unavailable · Requested'}
            </span>
          </li>
        ))}
      </ul>
      <div className="telos-control-actions">
        <button onClick={read} disabled={busy}>
          Check acknowledgements
        </button>
        {coordinator && value.origin !== 'operator_pause' && value.stage !== 'released' && (
          <button onClick={release} disabled={!canRelease || !current || busy}>
            Release held leads
          </button>
        )}
      </div>
      <details>
        <summary>Recorded control evidence</summary>
        <p>
          Control {value.controlId} ·{' '}
          {value.origin === 'operator_pause'
            ? 'requested by operator'
            : `original coordinator conversation ${value.coordinatorConversationId}`}
        </p>
        {evidence.length === 0 ? (
          <p>No native acknowledgement or host application evidence recorded.</p>
        ) : (
          <ul>
            {evidence.map((event) => (
              <li key={event.eventId}>
                {name(event.itemId)} · {stages[event.stage]} · {event.role} conversation{' '}
                {event.conversationId} · assignment revision {event.assignmentRevision} ·{' '}
                {event.evidenceRef}
              </li>
            ))}
          </ul>
        )}
      </details>
    </article>
  );
}
