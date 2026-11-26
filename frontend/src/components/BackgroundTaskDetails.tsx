import { useSyncExternalStore } from 'react';
import type { SubagentState } from '@mitzo/protocol';
import type { BackgroundTaskStopController } from '../lib/background-task-stop';
import './BackgroundTaskDetails.css';

const unavailable = { status: 'unavailable', checking: false, checkFailed: false } as const;
const unavailableSnapshot = () => unavailable;
const noSubscribe = () => () => {};
const outputLimit = 16_000;

export function BackgroundTaskDetails({
  subagent,
  sessionId,
  control,
}: {
  subagent: SubagentState;
  sessionId?: string;
  control?: BackgroundTaskStopController;
}) {
  // A control is supplied by a separately authorized owner, never derived from
  // observed IDs. Fail closed when this row is reused for another chat/run.
  const task = subagent.backgroundTask;
  const bound =
    control &&
    task &&
    control.execution.sessionId === sessionId &&
    control.execution.subagentMessageId === subagent.messageId &&
    control.execution.processGeneration === task.processGeneration &&
    control.execution.taskId === task.taskId &&
    control.execution.runId === task.runId
      ? control
      : undefined;
  const request = useSyncExternalStore<
    ReturnType<BackgroundTaskStopController['getSnapshot']> | typeof unavailable
  >(
    bound?.subscribe ?? noSubscribe,
    bound?.getSnapshot ?? unavailableSnapshot,
    unavailableSnapshot,
  );
  const blocks = Array.isArray(subagent.blocks) ? subagent.blocks : [...subagent.blocks.values()];
  const output = blocks
    .flatMap((block) =>
      block.blockType === 'text'
        ? [block.content]
        : block.blockType === 'tool_use' && block.toolResult
          ? [block.toolResult]
          : [],
    )
    .join('\n');
  const latest = output || subagent.summary || '';
  const canStop = subagent.status === 'running';
  const unsettled = canStop || subagent.status === 'unavailable';

  return (
    <div className="background-task-detail">
      {output && subagent.summary && <p>{subagent.summary}</p>}
      {latest ? (
        <>
          {latest.length > outputLimit && (
            <p>Showing the latest {outputLimit.toLocaleString()} characters of retained output.</p>
          )}
          <pre className="background-task-output" tabIndex={0} aria-label="Task output">
            {latest.slice(-outputLimit)}
          </pre>
        </>
      ) : (
        <p>No task output has been recorded.</p>
      )}
      {subagent.status === 'unavailable' && (
        <p>Status unavailable. Retained output does not confirm whether the task stopped.</p>
      )}
      {subagent.status === 'failed' && (
        <p>Task failed. Review retained output before retrying work.</p>
      )}
      {unsettled && (
        <div className="background-task-controls">
          <button
            type="button"
            className="home-secondary"
            disabled={!bound || !canStop || request.status !== 'idle'}
            onClick={() => {
              void bound?.request();
            }}
          >
            Stop task
          </button>
          <p role="status">
            {request.status === 'unavailable'
              ? 'Task-only Stop is not available for this runtime. This control cannot stop the parent chat.'
              : request.status === 'pending'
                ? 'Sending Stop request'
                : request.status === 'requested'
                  ? 'Stop requested; waiting for task outcome'
                  : request.status === 'refused'
                    ? 'Stop unavailable: the task owner refused this request.'
                    : request.status === 'unknown'
                      ? 'Stop outcome unconfirmed'
                      : 'Stop applies only to this task.'}
          </p>
          {bound && ['unknown', 'requested', 'refused'].includes(request.status) && (
            <button
              type="button"
              className="home-secondary"
              disabled={request.checking}
              onClick={() => {
                void bound.check();
              }}
            >
              {request.checking ? 'Checking Stop request' : 'Check Stop request'}
            </button>
          )}
          {request.checkFailed && (
            <p role="alert">
              Could not check the Stop request. Its last receipt is retained; check again when
              connected.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
