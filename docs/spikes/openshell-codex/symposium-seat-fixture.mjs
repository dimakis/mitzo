/**
 * Minimal orchestration contract, intentionally mocked: the `turn` functions
 * stand in for two independently bound provider runtimes. The fixture proves
 * Mitzo must construct per-seat model input and preserve provenance; both seats
 * deliberately share the Symposium filesystem and it makes no model, network,
 * or filesystem call.
 */
export function createSymposiumFixture() {
  const seats = {
    builder: {
      account: 'chatgpt-subscription',
      model: 'gpt-5.6-terra',
      grants: ['shared-objective', 'builder-only-plan'],
      workspace: 'symposium-shared',
    },
    reviewer: {
      account: 'vertex',
      model: 'reviewer-model',
      grants: ['shared-objective', 'review-package'],
      workspace: 'symposium-shared',
    },
  };

  return {
    async run() {
      const builder = {
        account: seats.builder.account,
        received: [...seats.builder.grants],
        workspace: seats.builder.workspace,
      };
      const reviewer = {
        account: seats.reviewer.account,
        received: [...seats.reviewer.grants],
        workspace: seats.reviewer.workspace,
      };
      const transcript = [
        {
          seat: 'builder',
          original: 'builder draft',
          delivered: 'redacted finding request',
          deliveredTo: 'reviewer',
        },
      ];
      return { builder, reviewer, transcript };
    },
  };
}
