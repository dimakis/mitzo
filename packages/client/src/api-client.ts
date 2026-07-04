/**
 * Typed REST API client for Mitzo server.
 *
 * Replaces ad-hoc fetch() calls scattered across 20+ frontend files.
 * Uses a TransportAdapter.fetch so it works in both browser and Theia.
 */

import type { FinishedMessage, Session } from '@mitzo/protocol';
import type { Task } from './slices/tasks.js';
import type { TodoItem } from './slices/todos.js';
import type { InboxItem } from './slices/inbox.js';
import type { CalendarEvent, SprintInfo } from './slices/calendar.js';
import type { ContextBlockEntry, SkillMetadata } from './slices/config.js';

// ─── Transport ───────────────────────────────────────────────────────────────

export interface ApiFetch {
  (url: string, init?: RequestInit): Promise<Response>;
}

// ─── Response types ──────────────────────────────────────────────────────────

export interface AuthCheckResult {
  authenticated: boolean;
}

export interface VersionInfo {
  version: string;
  commit?: string;
}

export interface GitInfo {
  branch: string;
  worktrees: Array<{ path: string; branch: string }>;
}

export interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  size?: number;
}

export interface AppConfig {
  contextBlocks: Record<string, ContextBlockEntry>;
  fileRoots: string[];
  quickActions?: Array<{ label: string; prompt: string }>;
}

export interface SessionMetaResponse {
  sessionId: string;
  branch: string | null;
  wtId: string | null;
  cwd: string | null;
  mode: string;
  isActive: boolean;
  totalTokens: number;
  totalCostUsd: number;
  numTurns: number;
  telosTaskId: string | null;
}

export interface CalendarData {
  events: CalendarEvent[];
  sprints: SprintInfo[];
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class MitzoApiClient {
  constructor(private fetch: ApiFetch) {}

  private async assertOk(res: Response): Promise<Response> {
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`API ${res.status}: ${body || res.statusText}`);
    }
    return res;
  }

  // ── Auth ─────────────────────────────────────────────────────────────────

  async checkAuth(): Promise<AuthCheckResult> {
    const res = await this.assertOk(
      await this.fetch('/api/auth/check', { credentials: 'include' }),
    );
    return res.json();
  }

  async login(passphrase: string): Promise<Response> {
    return this.assertOk(
      await this.fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ passphrase }),
      }),
    );
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  async listSessions(offset?: number): Promise<Session[]> {
    const url = offset ? `/api/sessions?offset=${offset}` : '/api/sessions';
    const res = await this.assertOk(await this.fetch(url, { credentials: 'include' }));
    return res.json();
  }

  async getSessionMessages(sessionId: string, signal?: AbortSignal): Promise<FinishedMessage[]> {
    const res = await this.assertOk(
      await this.fetch(`/api/sessions/${sessionId}/messages`, {
        credentials: 'include',
        signal,
      }),
    );
    return res.json();
  }

  async getSessionMeta(sessionId: string): Promise<SessionMetaResponse | null> {
    const res = await this.fetch(`/api/sessions/${sessionId}/meta`, { credentials: 'include' });
    if (!res.ok) return null;
    return res.json();
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.assertOk(
      await this.fetch(`/api/sessions/${sessionId}`, {
        method: 'DELETE',
        credentials: 'include',
      }),
    );
  }

  async deleteAllSessions(): Promise<void> {
    await this.assertOk(
      await this.fetch('/api/sessions', {
        method: 'DELETE',
        credentials: 'include',
      }),
    );
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    await this.assertOk(
      await this.fetch(`/api/sessions/${sessionId}/rename`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ title }),
      }),
    );
  }

  // ── Config ───────────────────────────────────────────────────────────────

  async getConfig(): Promise<AppConfig> {
    const res = await this.assertOk(await this.fetch('/api/config', { credentials: 'include' }));
    return res.json();
  }

  async getVersion(): Promise<VersionInfo> {
    const res = await this.assertOk(await this.fetch('/api/version', { credentials: 'include' }));
    return res.json();
  }

  async checkForUpdate(): Promise<{ updateAvailable: boolean; latestVersion?: string }> {
    const res = await this.assertOk(
      await this.fetch('/api/version/check', {
        method: 'POST',
        credentials: 'include',
      }),
    );
    return res.json();
  }

  // ── Files ────────────────────────────────────────────────────────────────

  async getFileRoots(): Promise<string[]> {
    const res = await this.assertOk(
      await this.fetch('/api/files/roots', { credentials: 'include' }),
    );
    return res.json();
  }

  async getGitInfo(): Promise<GitInfo> {
    const res = await this.assertOk(await this.fetch('/api/git/info', { credentials: 'include' }));
    return res.json();
  }

  async listDirectory(dir: string, root?: string): Promise<FileEntry[]> {
    const params = new URLSearchParams({ dir });
    if (root) params.set('root', root);
    const res = await this.assertOk(
      await this.fetch(`/api/files?${params}`, { credentials: 'include' }),
    );
    return res.json();
  }

  async readFile(path: string): Promise<string> {
    const params = new URLSearchParams({ path });
    const res = await this.assertOk(
      await this.fetch(`/api/files/read?${params}`, { credentials: 'include' }),
    );
    return res.text();
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.assertOk(
      await this.fetch('/api/files/write', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ path, content }),
      }),
    );
  }

  // ── Tasks & Loop ─────────────────────────────────────────────────────────

  async getTasks(): Promise<Task[]> {
    const res = await this.assertOk(await this.fetch('/api/tasks', { credentials: 'include' }));
    const data = await res.json();
    return Array.isArray(data) ? data : (data.tasks ?? []);
  }

  async createTask(input: Partial<Task>): Promise<Task> {
    const res = await this.assertOk(
      await this.fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(input),
      }),
    );
    return res.json();
  }

  async updateTask(taskId: string, update: Partial<Task>): Promise<Task> {
    const res = await this.assertOk(
      await this.fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(update),
      }),
    );
    return res.json();
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.assertOk(
      await this.fetch(`/api/tasks/${taskId}`, {
        method: 'DELETE',
        credentials: 'include',
      }),
    );
  }

  async approveTask(taskId: string): Promise<void> {
    await this.assertOk(
      await this.fetch(`/api/tasks/${taskId}/approve`, {
        method: 'POST',
        credentials: 'include',
      }),
    );
  }

  async rejectTask(taskId: string, feedback: string): Promise<void> {
    await this.assertOk(
      await this.fetch(`/api/tasks/${taskId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ feedback }),
      }),
    );
  }

  async getLoopStatus(): Promise<{
    state: string;
    goalId: string | null;
    activeTaskId?: string | null;
    progress?: { completed: number; total: number } | null;
    specMode?: boolean;
    awaitingApproval?: boolean;
    spawnEnabled?: boolean;
  }> {
    const res = await this.assertOk(
      await this.fetch('/api/loop/status', { credentials: 'include' }),
    );
    return res.json();
  }

  async startLoop(goalId: string, specMode?: boolean): Promise<void> {
    await this.assertOk(
      await this.fetch('/api/loop/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ goalId, specMode }),
      }),
    );
  }

  async pauseLoop(): Promise<void> {
    await this.assertOk(
      await this.fetch('/api/loop/pause', { method: 'POST', credentials: 'include' }),
    );
  }

  async resumeLoop(): Promise<void> {
    await this.assertOk(
      await this.fetch('/api/loop/resume', { method: 'POST', credentials: 'include' }),
    );
  }

  async stopLoop(): Promise<void> {
    await this.assertOk(
      await this.fetch('/api/loop/stop', { method: 'POST', credentials: 'include' }),
    );
  }

  async setSpawnEnabled(enabled: boolean): Promise<void> {
    await this.assertOk(
      await this.fetch('/api/loop/spawn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ enabled }),
      }),
    );
  }

  async approveSpec(): Promise<void> {
    await this.assertOk(
      await this.fetch('/api/loop/spec/approve', { method: 'POST', credentials: 'include' }),
    );
  }

  async rejectSpec(): Promise<void> {
    await this.assertOk(
      await this.fetch('/api/loop/spec/reject', { method: 'POST', credentials: 'include' }),
    );
  }

  // ── Todos ────────────────────────────────────────────────────────────────

  async getTodos(profile?: string): Promise<{ items: TodoItem[]; profiles: string[] }> {
    const url = profile ? `/api/todos?profile=${encodeURIComponent(profile)}` : '/api/todos';
    const res = await this.assertOk(await this.fetch(url, { credentials: 'include' }));
    return res.json();
  }

  async createTodo(summary: string, profile: string, parentId?: string): Promise<TodoItem> {
    const res = await this.assertOk(
      await this.fetch('/api/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ summary, profile, parentId }),
      }),
    );
    return res.json();
  }

  async todoAction(todoId: string, action: string, days?: number): Promise<void> {
    await this.assertOk(
      await this.fetch(`/api/todos/${todoId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action, days }),
      }),
    );
  }

  // ── Calendar ─────────────────────────────────────────────────────────────

  async getCalendar(date: string, days: number): Promise<CalendarData> {
    const params = new URLSearchParams({ date, days: String(days) });
    const res = await this.assertOk(
      await this.fetch(`/api/calendar?${params}`, { credentials: 'include' }),
    );
    return res.json();
  }

  // ── Inbox ────────────────────────────────────────────────────────────────

  async getInbox(): Promise<InboxItem[]> {
    const res = await this.assertOk(await this.fetch('/api/inbox', { credentials: 'include' }));
    return res.json();
  }

  async getInboxItem(filename: string): Promise<string> {
    const res = await this.assertOk(
      await this.fetch(`/api/inbox/${filename}`, { credentials: 'include' }),
    );
    return res.text();
  }

  async approveInboxItem(filename: string): Promise<void> {
    await this.assertOk(
      await this.fetch(`/api/inbox/${filename}/approve`, {
        method: 'POST',
        credentials: 'include',
      }),
    );
  }

  async deleteInboxItem(filename: string): Promise<void> {
    await this.assertOk(
      await this.fetch(`/api/inbox/${filename}`, {
        method: 'DELETE',
        credentials: 'include',
      }),
    );
  }

  // ── Skills ───────────────────────────────────────────────────────────────

  async getSkills(cwd?: string): Promise<SkillMetadata[]> {
    const url = cwd ? `/api/skills?cwd=${encodeURIComponent(cwd)}` : '/api/skills';
    const res = await this.assertOk(await this.fetch(url, { credentials: 'include' }));
    return res.json();
  }
}
