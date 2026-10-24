import { expect, it } from 'vitest';
import { PendingHostTaskError } from '../pending-host-task.js';
import { preparationDiagnosticFailure } from './fixtures/preparation-attempt-diagnostics.js';

it.each(['service', 'schema', 'cas'])(
  'retains the original private %s exception without changing public uncertain error data',
  (phase) => {
    const cause = Error(`private ${phase} /synthetic/private/source`);
    const error = new PendingHostTaskError('pending_host_task_uncertain', { cause });
    expect(error.cause).toBe(cause);
    expect(error.message).toBe('pending_host_task_uncertain');
    expect(error.code).toBe('pending_host_task_uncertain');
    expect(Object.getOwnPropertyDescriptor(error, 'cause')?.enumerable).toBe(false);
    expect(JSON.stringify(error)).toBe('{"code":"pending_host_task_uncertain"}');
    expect(String(error)).toBe('Error: pending_host_task_uncertain');
    const projected = preparationDiagnosticFailure(error);
    expect(projected.cause?.messageSha256).toBeDefined();
    expect(JSON.stringify(projected)).not.toContain('/synthetic');
    expect(JSON.stringify(projected)).not.toContain(`private ${phase}`);
  },
);
