import type { OrdinaryLocalCommandAdmission } from '@mitzo/protocol';

type Selection = Readonly<Pick<OrdinaryLocalCommandAdmission, 'binding' | 'selection'>>;
const reference = (value: string | undefined) =>
  value && value.length <= 200 && !/\s/.test(value) ? value : 'unknown';

/** Trace-only projection of the existing command owner. No credentials, payloads,
 * mutable session settings or metric labels. Retain at most one dispatched command. */
export class ClaudeTurnAttribution {
  private readonly unknown: Readonly<Record<string, string>>;
  private selected?: { commandId: string; attributes: Readonly<Record<string, string>> };

  constructor(
    private readonly activeCommandId: () => string | undefined,
    releaseRevision?: string,
  ) {
    this.unknown = Object.freeze({
      'mitzo.engine': 'claude-sdk',
      'mitzo.route': 'unknown',
      'mitzo.account.id': 'unknown',
      'gen_ai.request.model': 'unknown',
      'mitzo.command.id': 'unknown',
      'mitzo.release.revision':
        releaseRevision && /^[a-f0-9]{40}$/.test(releaseRevision) ? releaseRevision : 'unknown',
    });
  }

  /** Called after settings are applied, at the existing frozen-input push hook.
   * resolvedModel is the exact model passed to SDK settings (API IDs stay opaque). */
  select(commandId: string, admission: Selection, resolvedModel: string): void {
    const { account, harness } = admission.binding;
    const supported =
      harness.implementation === 'claude-sdk' &&
      ['anthropic-claude', 'anthropic-vertex', 'anthropic-api'].includes(account.provider);
    this.selected = {
      commandId,
      attributes: Object.freeze({
        ...this.unknown,
        ...(supported
          ? {
              'mitzo.route': account.provider,
              'mitzo.account.id': reference(account.accountId),
              'gen_ai.request.model': reference(resolvedModel),
              'mitzo.command.id': reference(commandId),
            }
          : {}),
      }),
    };
  }

  attributes(): Readonly<Record<string, string>> {
    // Preparing, failed and completed commands cannot borrow the previous turn's
    // identity. Existing owner fences remain the authority for event delivery.
    return this.selected && this.selected.commandId === this.activeCommandId()
      ? this.selected.attributes
      : this.unknown;
  }
}
