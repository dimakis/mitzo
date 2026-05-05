import { useState } from 'react';
import type { LoopStatus } from '../types/task';
import type { Task } from '../types/task';
import { formatTokens } from '../lib/formatTokens';

interface LoopControlsProps {
  loopStatus: LoopStatus;
  goals: Task[];
  totalTokenUsage: number;
  onStart: (goalId: string, specMode?: boolean) => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onApproveSpec: () => void;
  onRejectSpec: () => void;
}

export function LoopControls({
  loopStatus,
  goals,
  totalTokenUsage,
  onStart,
  onPause,
  onResume,
  onStop,
  onApproveSpec,
  onRejectSpec,
}: LoopControlsProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedGoalId, setSelectedGoalId] = useState('');
  const [specMode, setSpecMode] = useState(false);

  const { state, progress, awaitingApproval } = loopStatus;

  // ── Idle: compact trigger / expanded picker ──
  if (state === 'idle') {
    if (!pickerOpen) {
      return (
        <div className="loop-controls">
          <button className="loop-controls-start-trigger" onClick={() => setPickerOpen(true)}>
            {'\u25B8'} Start a workflow...
          </button>
        </div>
      );
    }

    return (
      <div className="loop-controls">
        <div className="loop-controls-start-expanded">
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
          <div className="loop-controls-start-row">
            <label className="loop-controls-spec-toggle">
              <input
                type="checkbox"
                checked={specMode}
                onChange={(e) => setSpecMode(e.target.checked)}
              />
              Spec mode
            </label>
            <div className="loop-controls-spacer" />
            <button className="loop-controls-btn" onClick={() => setPickerOpen(false)}>
              Cancel
            </button>
            <button
              className="loop-controls-btn loop-controls-btn--start"
              disabled={!selectedGoalId}
              onClick={() => {
                onStart(selectedGoalId, specMode || undefined);
                setPickerOpen(false);
              }}
            >
              Start
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Running / Paused / Review: inline bar ──
  const isReview = awaitingApproval;
  const pillClass = isReview
    ? 'loop-controls-pill--review'
    : state === 'paused'
      ? 'loop-controls-pill--paused'
      : 'loop-controls-pill--running';
  const pillLabel = isReview
    ? '\u26A0 Needs Review'
    : state === 'paused'
      ? 'Paused'
      : '\u25CF Running';

  return (
    <div className="loop-controls">
      <div className="loop-controls-inline-bar">
        <div className="loop-controls-inline-bar-top">
          <span className={`loop-controls-pill ${pillClass}`}>{pillLabel}</span>
          <div className="loop-controls-spacer" />
          <div className="loop-controls-actions">
            {state === 'running' && !awaitingApproval && (
              <button className="loop-controls-btn" onClick={onPause} title="Pause">
                {'\u23F8'}
              </button>
            )}
            {state === 'paused' && !awaitingApproval && (
              <button
                className="loop-controls-btn loop-controls-btn--start"
                onClick={onResume}
                title="Resume"
              >
                {'\u25B6'}
              </button>
            )}
            <button
              className="loop-controls-btn loop-controls-btn--danger"
              onClick={onStop}
              title="Stop"
            >
              {'\u25A0'}
            </button>
          </div>
        </div>
        {progress && progress.total > 0 && (
          <div className="loop-controls-inline-bar-bottom">
            <div className="loop-controls-bar">
              <div
                className="loop-controls-bar-fill"
                style={{ width: `${(progress.done / progress.total) * 100}%` }}
              />
            </div>
            <span className="loop-controls-progress">
              {progress.done}/{progress.total}
            </span>
            {totalTokenUsage > 0 && (
              <span className="loop-controls-token-count">{formatTokens(totalTokenUsage)}</span>
            )}
          </div>
        )}
      </div>

      {awaitingApproval && (
        <div className="loop-controls-approval-card">
          <p className="loop-controls-approval-msg">Task breakdown ready for review</p>
          <div className="loop-controls-actions">
            <button className="loop-controls-btn loop-controls-btn--start" onClick={onApproveSpec}>
              {'\u2713'} Approve
            </button>
            <button className="loop-controls-btn loop-controls-btn--danger" onClick={onRejectSpec}>
              {'\u2717'} Reject
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
