import type { CapabilityTemplate } from '../types.js';
import type { CapabilityExecutor } from './types.js';

const symbolicIdentifier = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

/** Code-owned only registry.  Templates cannot point at modules or commands. */
export class CapabilityExecutorRegistry {
  private readonly executors: Readonly<Record<string, CapabilityExecutor>>;

  constructor(entries: Readonly<Record<string, CapabilityExecutor>>) {
    const safe = Object.create(null) as Record<string, CapabilityExecutor>;
    for (const [name, executor] of Object.entries(entries)) {
      if (
        !symbolicIdentifier.test(name) ||
        !executor ||
        typeof executor.execute !== 'function' ||
        typeof executor.verify !== 'function' ||
        typeof executor.recover !== 'function'
      )
        throw new Error('Invalid capability executor registration');
      safe[name] = executor;
    }
    this.executors = Object.freeze(safe);
  }

  resolve(template: CapabilityTemplate): CapabilityExecutor {
    if (
      !symbolicIdentifier.test(template.executor) ||
      !Object.hasOwn(this.executors, template.executor)
    )
      throw new Error('Unknown capability executor');
    return this.executors[template.executor]!;
  }

  /** Used when advertising dynamic tools. A declaration alone is not executable. */
  supports(template: CapabilityTemplate): boolean {
    return (
      symbolicIdentifier.test(template.executor) && Object.hasOwn(this.executors, template.executor)
    );
  }
}
