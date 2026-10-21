import { fromJSON, type ServiceDefinition } from '@grpc/proto-loader';
// Explicit opt-in wire contract: workspace selectors + operator GetProviderCredentials.
// Source: NVIDIA/OpenShell proto/{openshell,datamodel}.proto, retrieved 2026-10-21.
// This is NOT compatible with Mitzo's historical 0.0.116 provider-update contract.
const f = (type: string, id: number, rule?: 'repeated') => ({
  type,
  id,
  ...(rule ? { rule } : {}),
});
const map = (type: string, id: number) => ({ type, id, keyType: 'string' as const });
const protocol: Parameters<typeof fromJSON>[0] = {
  nested: {
    openshell: {
      nested: {
        v1: {
          nested: {
            Scope: { fields: { workspace: f('string', 1) } },
            Meta: {
              fields: {
                id: f('string', 1),
                name: f('string', 2),
                resource_version: f('uint64', 5),
                workspace: f('string', 7),
              },
            },
            Provider: {
              fields: {
                metadata: f('Meta', 1),
                type: f('string', 2),
                credentials: map('string', 3),
                config: map('string', 4),
                profile_workspace: f('string', 6),
              },
            },
            GetProviderRequest: {
              fields: { name: f('string', 1), workspace_scope: f('Scope', 2) },
            },
            CreateProviderRequest: {
              fields: {
                provider: f('Provider', 1),
                workspace_scope: f('Scope', 2),
                request_id: f('string', 3),
              },
            },
            ProviderResponse: { fields: { provider: f('Provider', 1) } },
            GetProviderCredentialsRequest: {
              fields: {
                workspace_scope: f('Scope', 1),
                name: f('string', 2),
                credential_keys: f('string', 3, 'repeated'),
              },
            },
            Value: { fields: { value: f('string', 1) } },
            GetProviderCredentialsResponse: { fields: { credentials: map('Value', 1) } },
            GetProviderProfileRequest: {
              fields: { id: f('string', 1), workspace_scope: f('Scope', 2) },
            },
            Credential: {
              fields: {
                name: f('string', 1),
                description: f('string', 2),
                env_vars: f('string', 3, 'repeated'),
                required: f('bool', 4),
                auth_style: f('string', 5),
                header_name: f('string', 6),
                query_param: f('string', 7),
                refresh: f('bytes', 8),
                path_template: f('string', 9),
                token_grant: f('bytes', 10),
              },
            },
            // Opaque embedded messages preserve presence; no parser can silently discard
            // endpoints/files/discovery and mistake an injectable profile for a vault.
            Profile: {
              fields: {
                id: f('string', 1),
                credentials: f('Credential', 5, 'repeated'),
                endpoints: f('bytes', 6, 'repeated'),
                binaries: f('bytes', 7, 'repeated'),
                inference_capable: f('bool', 8),
                discovery: f('bytes', 9),
                resource_version: f('uint64', 10),
                files: f('bytes', 14, 'repeated'),
              },
            },
            ProviderProfileResponse: { fields: { profile: f('Profile', 1) } },
            OpenShell: {
              methods: {
                GetProvider: {
                  comment: 'Inspect a pinned provider.',
                  requestType: 'GetProviderRequest',
                  responseType: 'ProviderResponse',
                },
                CreateProvider: {
                  comment: 'Create one private relay provider.',
                  requestType: 'CreateProviderRequest',
                  responseType: 'ProviderResponse',
                },
                GetProviderCredentials: {
                  comment: 'Export one runtime credential to the trusted operator.',
                  requestType: 'GetProviderCredentialsRequest',
                  responseType: 'GetProviderCredentialsResponse',
                },
                GetProviderProfile: {
                  comment: 'Verify the non-injecting vault profile.',
                  requestType: 'GetProviderProfileRequest',
                  responseType: 'ProviderProfileResponse',
                },
              },
            },
          },
        },
      },
    },
  },
};
export const openShellSecretService = fromJSON(protocol, {
  keepCase: true,
  longs: String,
  defaults: false,
})['openshell.v1.OpenShell'] as ServiceDefinition;
