import { useId, useState } from 'react';
import type { NativeSubagentControl, NativeSubagentSnapshot } from '@mitzo/protocol';
import { useNativeSubagents } from '../hooks/useNativeSubagents';
import { createBrowserId } from '../lib/browser-crypto';
import { HomeDialog } from './HomeDialog';
import { MotionPresence } from './MotionPresence';
import { UiIcon } from './UiIcon';
import { TextBubble } from './MessageBubble';
import { ToolPill } from './ToolPill';
import './NativeSubagents.css';

const labels: Record<NativeSubagentSnapshot['state'], string> = {
  starting: 'Starting',
  working: 'Working',
  needs_permission: 'Needs permission',
  completed: 'Result returned',
  failed: 'Failed',
  stopping: 'Stopping…',
  stopped: 'Stopped',
  unknown: 'Activity unknown',
};
const inspectionStages: Record<
  NonNullable<NativeSubagentSnapshot['inspectionFailure']>['stage'],
  string
> = {
  inspect_child: 'child inspection',
  inspect_parent: 'parent inspection',
  validate_identity: 'identity verification',
  subscribe: 'activity subscription',
  history: 'history loading',
  events: 'activity recovery',
  capacity: 'inspection capacity checks',
};
interface Delivery {
  input: NativeSubagentControl;
  status: 'sending' | 'accepted' | 'rejected' | 'uncertain';
}
export function NativeSubagents({
  sessionId,
  commandId,
}: {
  sessionId: string;
  commandId: string;
}) {
  const feed = useNativeSubagents(sessionId);
  const agents = feed.agents.filter((agent) => agent.commandId === commandId);
  const [expanded, setExpanded] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [deliveries, setDeliveries] = useState<Record<string, Delivery>>({});
  const listId = useId();
  const selected = agents.find((agent) => agent.threadId === selectedId);
  const delivery = selected ? deliveries[selected.threadId] : undefined;
  const busy = delivery?.status === 'sending' || delivery?.status === 'uncertain';
  const working = agents.filter((agent) => agent.state === 'working').length;
  const attention = agents.filter((agent) => agent.state === 'needs_permission').length;
  const unavailable = agents.filter((agent) => agent.inspectionFailure).length;
  const summary = `${agents.length || ''}${agents.length ? ' ' : ''}subagent${agents.length === 1 ? '' : 's'}${working ? ` · ${working} working` : ''}${attention ? ` · ${attention} need permission` : ''}${unavailable ? ` · ${unavailable} unavailable` : ''}`;
  const canMessage =
    !!selected &&
    feed.available &&
    selected.available !== false &&
    !busy &&
    ['working', 'needs_permission', 'completed', 'stopped'].includes(selected.state);
  const canStop =
    !!selected &&
    feed.available &&
    selected.available !== false &&
    !busy &&
    ['working', 'needs_permission'].includes(selected.state);
  async function deliver(input: NativeSubagentControl) {
    setDeliveries((previous) => ({ ...previous, [input.threadId]: { input, status: 'sending' } }));
    const status = await feed.control(input);
    setDeliveries((previous) => ({ ...previous, [input.threadId]: { input, status } }));
    if (status === 'accepted' && input.action === 'message')
      setDrafts((previous) => ({
        ...previous,
        [input.threadId]: previous[input.threadId] === input.text ? '' : previous[input.threadId],
      }));
  }
  const message = () => {
    if (!selected || !canMessage || !drafts[selected.threadId]?.trim()) return;
    void deliver({
      requestId: createBrowserId(),
      threadId: selected.threadId,
      action: 'message',
      text: drafts[selected.threadId],
    });
  };
  return (
    <section className="native-subagents" aria-label="Subagents">
      <button
        type="button"
        className="native-subagent-summary"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => setExpanded((value) => !value)}
      >
        <UiIcon name={expanded ? 'down' : 'forward'} size={16} />
        <UiIcon name="agents" size={16} />
        <span>{summary}</span>
      </button>
      <MotionPresence open={expanded} kind="disclosure" appear={false}>
        <div id={listId} className="native-subagent-list">
          {agents.map((agent) => (
            <button
              type="button"
              key={agent.threadId}
              className="native-subagent-row"
              onClick={() => setSelectedId(agent.threadId)}
            >
              <span>{agent.name}</span>
              <span className="native-subagent-state">
                {agent.inspectionFailure
                  ? 'Inspection unavailable'
                  : labels[
                      !feed.available &&
                      ['working', 'starting', 'needs_permission'].includes(agent.state)
                        ? 'unknown'
                        : agent.state
                    ]}
              </span>
              <UiIcon name="forward" size={16} />
            </button>
          ))}
          {(!feed.available || feed.error) && (
            <p className="native-subagent-note" role="status">
              {feed.error ?? 'The original runtime is unavailable. Saved output remains readable.'}{' '}
              <button type="button" className="home-secondary" onClick={feed.reconnect}>
                Refresh activity
              </button>
            </p>
          )}
        </div>
      </MotionPresence>
      {selected && (
        <HomeDialog
          title={selected.name}
          className="native-subagent-dialog"
          onClose={() => setSelectedId(undefined)}
          onBack={() => setSelectedId(undefined)}
          backLabel="Back to conversation"
        >
          <div className="native-subagent-body">
            <p className="native-subagent-note">
              Subagent of this agent · Outside the shared discussion
            </p>
            <p className="native-subagent-task">{selected.task}</p>
            {selected.outputTruncated && (
              <p className="native-subagent-note">
                Showing the latest activity. Earlier output remains in the native thread history.
              </p>
            )}
            <p className="native-subagent-state" role="status">
              {
                labels[
                  !feed.available &&
                  ['working', 'starting', 'needs_permission'].includes(selected.state)
                    ? 'unknown'
                    : selected.state
                ]
              }
            </p>
            {selected.inspectionFailure && (
              <p className="native-subagent-note" role="status">
                Subagent inspection failed during{' '}
                {inspectionStages[selected.inspectionFailure.stage]}. Execution status is uncertain;
                controls are unavailable. Refresh activity to check for updates. Reference:{' '}
                {selected.inspectionFailure.reference}.{' '}
                <button type="button" className="home-secondary" onClick={feed.reconnect}>
                  Refresh activity
                </button>
              </p>
            )}
            {selected.blocks.map((block) =>
              block.type === 'tool' ? (
                <ToolPill
                  key={block.id}
                  sessionId={sessionId}
                  block={{
                    blockId: block.id,
                    blockType: 'tool_use',
                    content: '',
                    toolName: block.name,
                    toolInput: block.content,
                    toolResult: block.status === 'running' ? undefined : block.content,
                    toolError: block.status === 'failed',
                    toolInterrupted: block.status === 'unknown',
                  }}
                />
              ) : block.type === 'user' ? (
                <p key={block.id} className="native-subagent-instruction">
                  <strong>You</strong> {block.content}
                </p>
              ) : (
                <TextBubble key={block.id} content={block.content} artifactSessionId={sessionId} />
              ),
            )}
            {selected.usage && (
              <p className="native-subagent-note">
                Observed usage: {selected.usage.inputTokens.toLocaleString()} input ·{' '}
                {selected.usage.outputTokens.toLocaleString()} output tokens
              </p>
            )}
          </div>
          <form
            className="native-subagent-composer"
            onSubmit={(event) => {
              event.preventDefault();
              message();
            }}
          >
            <label htmlFor={`${listId}-message`}>Message {selected.name}</label>
            <textarea
              id={`${listId}-message`}
              value={drafts[selected.threadId] ?? ''}
              disabled={!canMessage}
              rows={3}
              onChange={(event) =>
                setDrafts((previous) => ({ ...previous, [selected.threadId]: event.target.value }))
              }
            />
            <p className="native-subagent-note">Only {selected.name} receives this message.</p>
            {delivery?.status === 'uncertain' && (
              <p role="alert">Delivery is uncertain. Check this request before sending another.</p>
            )}
            {delivery?.status === 'rejected' && (
              <p role="alert">This request was not accepted. Your draft is retained.</p>
            )}
            {delivery?.status === 'accepted' && (
              <p role="status">
                {delivery.input.action === 'stop'
                  ? 'Stop requested. Waiting for acknowledgement.'
                  : 'Message delivered.'}
              </p>
            )}
            <footer>
              <button
                type="button"
                className="home-secondary home-danger"
                aria-label={`Stop ${selected.name}`}
                disabled={!canStop}
                onClick={() =>
                  void deliver({
                    requestId: createBrowserId(),
                    threadId: selected.threadId,
                    action: 'stop',
                  })
                }
              >
                {selected.state === 'stopping' ? 'Stopping…' : 'Stop'}
              </button>
              {delivery?.status === 'uncertain' ? (
                <button
                  type="button"
                  className="home-secondary"
                  onClick={() => void deliver(delivery.input)}
                >
                  Check delivery
                </button>
              ) : (
                <button
                  type="submit"
                  className="home-secondary"
                  aria-label={`Send to ${selected.name}`}
                  disabled={!canMessage || !drafts[selected.threadId]?.trim()}
                >
                  {delivery?.status === 'sending' ? 'Sending…' : 'Send'}
                </button>
              )}
            </footer>
          </form>
        </HomeDialog>
      )}
    </section>
  );
}
