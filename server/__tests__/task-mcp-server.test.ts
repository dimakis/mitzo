import { describe, it, expect } from 'vitest';
import { getToolTier, shouldAutoAllow } from '../tool-tiers.js';
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

  it('requires approval for Telos outcome creation', () => {
    expect(getToolTier('mcp__telos__TelosCreateOutcome')).toBe('unknown');
  });

  it('permits read-only Telos recovery and requires approval for document uploads', () => {
    for (const prefix of ['', 'mcp__telos__']) {
      expect(getToolTier(prefix + 'TelosFindArtifacts')).toBe('safe');
      expect(getToolTier(prefix + 'TelosReadArtifact')).toBe('safe');
      expect(getToolTier(prefix + 'TelosSaveArtifact')).toBe('unknown');
    }
  });

  it('allows Telos inspection in Ask while retaining mutation approval', () => {
    for (const prefix of ['', 'mcp__telos__']) {
      expect(getToolTier(prefix + 'TelosGetItem')).toBe('safe');
      expect(shouldAutoAllow(prefix + 'TelosGetItem', 'ask')).toBe(true);
      expect(getToolTier(prefix + 'TelosUpdateItem')).toBe('unknown');
      expect(shouldAutoAllow(prefix + 'TelosUpdateItem', 'ask')).toBe(false);
      expect(shouldAutoAllow(prefix + 'TelosUpdateItem', 'auto')).toBe(false);
      expect(
        summarizeToolInput(prefix + 'TelosUpdateItem', { itemId: 'task', status: 'completed' }),
      ).toBe('Update Telos task: completed');
    }
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

  it('summarizes Telos outcome creation for the approval card', () => {
    expect(
      summarizeToolInput('mcp__telos__TelosCreateOutcome', {
        summary: 'Ship searchable outcomes',
      }),
    ).toBe('Create outcome: Ship searchable outcomes');
  });
});
