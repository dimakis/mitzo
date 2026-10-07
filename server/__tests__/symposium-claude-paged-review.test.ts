import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createClaudeVertexSeat, claudeVertexArgv } from '../symposium-claude-native.js';
import type { SymposiumSeatExecution } from '../symposium-orchestrator.js';

const execution = {
  sessionId: 'session',
  deliveryId: 'delivery',
  claimToken: 'claim',
  idempotencyKey: 'idempotency',
  content: 'Review sealed page 0: sealed-0',
  seat: {
    id: 'reviewer',
    name: 'Reviewer',
    model: 'claude-test',
    systemPrompt: 'Review safely.',
    color: '#112233',
    role: 'reviewer',
  },
  provenance: { membershipGeneration: 2 },
  signal: new AbortController().signal,
} as SymposiumSeatExecution;
const route = {
  kind: 'claude-vertex' as const,
  provider: 'vertex-work',
  providerId: 'vertex-object',
  model: 'claude-test',
  effort: 'low',
  projectId: 'project-1',
  region: 'us-east5',
  readOnly: true,
};
const sandbox = {
  sandboxName: 'shared',
  workdir: '/sandbox/workspaces/mgmt',
  cli: 'openshell',
  gateway: 'test-gateway',
  workspace: 'test-workspace',
  gatewayInsecure: false,
};

describe('Claude Vertex sealed page feed', () => {
  it.each([false, true])(
    'delivers sealed pages with host bridge %s only after the prior provider turn and records exact coverage',
    async (withBridge) => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        kill: (signal?: NodeJS.Signals) => boolean;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn(() => true);
      let sent = '';
      child.stdin.on('data', (chunk) => {
        sent += chunk.toString();
      });
      const markHostDelivered = vi.fn();
      const providerEvents: string[] = [];
      let dispatched = false;
      const readForHost = vi.fn((pageIndex: number) => {
        if (!dispatched) throw new Error('Page read before charged dispatch');
        return {
          context: `sealed-${pageIndex}`,
          receipt: {
            pageIndex,
            pageCount: 2,
            contextSha256: `hash-${pageIndex}`,
            evidenceSha256: 'e'.repeat(64),
            pagesSha256: 'p'.repeat(64),
          },
        };
      });
      let accepted = false;
      const bridge = {
        argv: ['--allowedTools', 'mcp__mitzo-host-access__RequestWebAccess'],
        activate: vi.fn(() => {
          expect(accepted).toBe(true);
        }),
        failed: new Promise<never>(() => {}),
        close: vi.fn().mockResolvedValue(undefined),
      };
      let spawnedArgv = '';
      const native = await createClaudeVertexSeat({
        sandbox,
        route,
        execution,
        spawnProcess: (spec) => {
          spawnedArgv = spec.args.join(' ');
          return child;
        },
        ...(withBridge
          ? {
              verifiedLauncher: true,
              hostTools: {
                tools: [
                  {
                    name: 'RequestWebAccess',
                    description: 'Read',
                    input_schema: { type: 'object' },
                  },
                ],
                instructions: 'Ask for user approval',
                executeTool: async () => ({ content: 'ok', isError: false }),
              },
              verifyHostTools: vi.fn(),
              createHostToolBridge: vi.fn().mockResolvedValue(bridge),
            }
          : {}),
        onEvent: (event) => providerEvents.push(String(event.type)),
        reviewPages: { readForHost, markHostDelivered } as never,
        requireModelReceipts: true,
      });
      const argv = claudeVertexArgv(route, execution, true);
      expect(argv).toContain('--input-format');
      const thread = argv[argv.indexOf('--session-id') + 1];
      expect(readForHost).not.toHaveBeenCalled();
      const run = native.run(execution, {
        beforeDispatch: () => {
          dispatched = true;
        },
        accepted: vi.fn(() => {
          accepted = true;
        }),
      });
      const lines = () =>
        sent
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
      expect(spawnedArgv).toContain('--input-format');
      if (withBridge) expect(spawnedArgv).toContain('mcp__mitzo-host-access__RequestWebAccess');
      expect(bridge.activate).not.toHaveBeenCalled();
      expect(lines()).toHaveLength(1);
      expect(lines()[0].message.content).toContain('Review sealed page 0');
      expect(markHostDelivered).not.toHaveBeenCalled();
      const emit = (value: Record<string, unknown>) =>
        child.stdout.write(JSON.stringify(value) + '\n');
      emit({ type: 'system', subtype: 'init', session_id: thread, model: 'claude-test' });
      emit({
        type: 'assistant',
        session_id: thread,
        message: {
          id: 'turn-0',
          model: 'claude-test',
          content: [{ type: 'text', text: 'provisional' }],
        },
      });
      emit({ type: 'result', session_id: thread, is_error: false });
      expect(lines()).toHaveLength(2);
      expect(lines()[1].message.content).toContain('sealed-1');
      expect(markHostDelivered).not.toHaveBeenCalled();
      emit({
        type: 'assistant',
        session_id: thread,
        message: {
          id: 'turn-1',
          model: 'claude-test',
          content: [{ type: 'text', text: 'provisional 1' }],
        },
      });
      emit({ type: 'result', session_id: thread, is_error: false });
      expect(markHostDelivered).toHaveBeenCalledExactlyOnceWith(1, 'hash-1');
      expect(lines()).toHaveLength(3);
      expect(lines()[2].message.content).toContain('final review JSON');
      emit({
        type: 'assistant',
        session_id: thread,
        message: {
          id: 'turn-final',
          model: 'claude-test',
          content: [{ type: 'text', text: '{"findings":[]}' }],
        },
      });
      emit({ type: 'result', session_id: thread, is_error: false });
      child.emit('close', 0);
      await expect(run).resolves.toMatchObject({ content: '{"findings":[]}' });
      expect(readForHost).toHaveBeenCalledWith(0);
      expect(providerEvents.filter((type) => type === 'result')).toHaveLength(1);
      if (withBridge) {
        expect(bridge.activate).toHaveBeenCalledOnce();
        expect(bridge.close).toHaveBeenCalledOnce();
      }
    },
  );
});
