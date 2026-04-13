import { useState } from 'react';
import type { LoopStatus } from '../types/task';
import type { Task } from '../types/task';

interface LoopControlsProps {
  loopStatus: LoopStatus;
  goals: Task[];
  onStart: (goalId: string, specMode?: boolean) => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onApproveSpec: () => void;
  onRejectSpec: () => void;
}

const STATE_LABELS: Record<LoopStatus['state'], string> = {
  idle: 'Idle',
  running: 'Running',
  paused: 'Paused',
};

export function LoopControls({
  loopStatus,
  goals,
  onStart,
  onPause,
  onResume,
  onStop,
  onApproveSpec,
  onRejectSpec,
}: LoopControlsProps) {
  const [selectedGoalId, setSelectedGoalId] = useState('');
  const [specMode, setSpecMode] = useState(false);

  const { state, progress, awaitingApproval } = loopStatus;

  return (
    <div className="loop-controls">
      <div className="loop-controls-header">
        <span className={`loop-controls-pill loop-controls-pill--${state}`}>
          {STATE_LABELS[state]}
        </span>
        {progress && (
          <span className="loop-controls-progress">
            {progress.done}/{progress.total}
          </span>
        )}
      </div>

      {state === 'idle' && (
        <div className="loop-controls-start">
          <select
            className="loop-controls-select"
            value={selectedGoalId}
            onChange={(e) => setSelectedGoalId(e.target.value)}
          >
            <option value="">Select a goal...</option>
            {goals.map((g) => (
              <option key={g.id} value={g.id}>
                {g.title}
              </option>
            ))}
          </select>
          <label className="loop-controls-spec-toggle">
            <input
              type="checkbox"
              checked={specMode}
              onChange={(e) => setSpecMode(e.target.checked)}
            />
            Spec mode
          </label>
          <button
            className="loop-controls-btn loop-controls-btn--start"
            disabled={!selectedGoalId}
            onClick={() => onStart(selectedGoalId, specMode || undefined)}
          >
            Start
          </button>
        </div>
      )}

      {state === 'running' && !awaitingApproval && (
        <div className="loop-controls-actions">
          <button className="loop-controls-btn" onClick={onPause}>
            Pause
          </button>
          <button className="loop-controls-btn loop-controls-btn--danger" onClick={onStop}>
            Stop
          </button>
        </div>
      )}

      {state === 'paused' && !awaitingApproval && (
        <div className="loop-controls-actions">
          <button className="loop-controls-btn loop-controls-btn--start" onClick={onResume}>
            Resume
          </button>
          <button className="loop-controls-btn loop-controls-btn--danger" onClick={onStop}>
            Stop
          </button>
        </div>
      )}

      {awaitingApproval && (
        <div className="loop-controls-approval">
          <p className="loop-controls-approval-msg">Task breakdown ready for review</p>
          <div className="loop-controls-actions">
            <button className="loop-controls-btn loop-controls-btn--start" onClick={onApproveSpec}>
              Approve
            </button>
            <button className="loop-controls-btn loop-controls-btn--danger" onClick={onRejectSpec}>
              Reject
            </button>
          </div>
        </div>
      )}

      {progress && progress.total > 0 && (
        <div className="loop-controls-bar">
          <div
            className="loop-controls-bar-fill"
            style={{ width: `${(progress.done / progress.total) * 100}%` }}
          />
        </div>
      )}
    </div>
  );
}
