import { fromJSON, type ServiceDefinition } from '@grpc/proto-loader';

/** Narrow wire contract, pinned to OpenShell b4c459f92446167afcb0a2dcf7d9fa6c8945e59c.
 * Field numbers come from proto/datamodel.proto and proto/openshell.proto.
 * Only provider reads and conditional updates are exposed; no API discovery or fallback. */
const protocol = {
  nested: {
    openshell: {
      nested: {
        v1: {
          nested: {
            Meta: {
              fields: {
                id: { type: 'string', id: 1 },
                name: { type: 'string', id: 2 },
                resource_version: { type: 'uint64', id: 5 },
                workspace: { type: 'string', id: 7 },
              },
            },
            Provider: {
              fields: {
                metadata: { type: 'Meta', id: 1 },
                type: { type: 'string', id: 2 },
                credentials: { keyType: 'string', type: 'string', id: 3 },
                config: { keyType: 'string', type: 'string', id: 4 },
                profile_workspace: { type: 'string', id: 6 },
              },
            },
            GetProviderRequest: {
              fields: { name: { type: 'string', id: 1 }, workspace: { type: 'string', id: 2 } },
            },
            UpdateProviderRequest: {
              fields: {
                provider: { type: 'Provider', id: 1 },
                workspace: { type: 'string', id: 3 },
              },
            },
            ProviderResponse: { fields: { provider: { type: 'Provider', id: 1 } } },
            OpenShell: {
              methods: {
                GetProvider: {
                  comment: 'Read the current pinned provider.',
                  requestType: 'GetProviderRequest',
                  responseType: 'ProviderResponse',
                },
                UpdateProvider: {
                  comment: 'Condition a credential update on provider metadata.resource_version.',
                  requestType: 'UpdateProviderRequest',
                  responseType: 'ProviderResponse',
                },
              },
            },
          },
        },
      },
    },
  },
};
export const openShellKeyApiService = fromJSON(protocol, {
  keepCase: true,
  longs: String,
  defaults: false,
})['openshell.v1.OpenShell'] as ServiceDefinition;
