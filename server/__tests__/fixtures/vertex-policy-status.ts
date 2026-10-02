/** Pinned provider_readiness.rs JSON envelope; values are synthetic, no credential. */
export function installedVertexStatus(input: {
  name: string;
  id: string;
  workspace: string;
  provider: string;
  providerId: string;
  hash: string;
  revision: string;
}) {
  const identity = {
    attachment_epoch: '',
    provider_env_revision: '7',
    config_revision: input.revision,
    policy_hash: input.hash,
  };
  return {
    mutation_id: 'observation',
    targets: [
      {
        state: 'ready',
        reason: 'unspecified',
        network_instance_id: 'network-process',
        receipt: {
          receipt_id: 'receipt',
          mutation_id: 'observation',
          kind: 'observe',
          provider: input.provider,
          workspace: input.workspace,
          desired: {
            ...identity,
            sandbox: input.name,
            sandbox_id: input.id,
            provider_id: input.providerId,
            provider_resource_version: '9',
          },
        },
        observed: {
          ...identity,
          session_id: 'supervisor-session',
          sequence: '1',
          process_instance_id: 'process-instance',
          credentials_installed: true,
          policy_active: true,
          launch_environment_installed: true,
          reason: 'unspecified',
        },
      },
    ],
  };
}
