import { describe, it, expect } from 'vitest';
import { getToolTier } from '../tool-tiers.js';
import { summarizeToolInput } from '../tool-summary.js';

describe('task-board MCP integration', () => {
  // --- Tool tiers ---

  it('classifies only read-only task-board status as safe', () => {
    expect(getToolTier('mcp__task-board__TaskSet')).toBe('unknown');
    expect(getToolTier('mcp__task-board__TaskComplete')).toBe('unknown');
    expect(getToolTier('mcp__task-board__TaskStatus')).toBe('safe');
    expect(getToolTier('mcp__task-board__TaskBlock')).toBe('unknown');
  });

  it('does not affect other MCP tools', () => {
    expect(getToolTier('mcp__other__SomeTool')).toBe('unknown');
  });

  // --- Tool summaries ---

  it('summarizes TaskSet input', () => {
    const summary = summarizeToolInput('mcp__task-board__TaskSet', {
      tasks: [{ title: 'A' }, { title: 'B' }],
    });
    expect(summary).toBe('2 subtasks');
  });

  it('summarizes TaskComplete input', () => {
    const summary = summarizeToolInput('mcp__task-board__TaskComplete', {
      summary: 'Implemented the feature',
    });
    expect(summary).toBe('Implemented the feature');
  });

  it('summarizes TaskStatus input', () => {
    const summary = summarizeToolInput('mcp__task-board__TaskStatus', {});
    expect(summary).toBe('get status');
  });

  it('summarizes TaskBlock input', () => {
    const summary = summarizeToolInput('mcp__task-board__TaskBlock', {
      reason: 'Missing API key',
    });
    expect(summary).toBe('Missing API key');
  });
});
