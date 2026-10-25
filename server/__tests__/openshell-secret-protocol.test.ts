import { expect, it } from 'vitest';
import { openShellSecretService } from '../openshell-secret-protocol.js';
it('encodes explicit workspace selectors and selected credential keys with official wire tags', () => {
  const rpc = openShellSecretService.GetProviderCredentials;
  expect(rpc.path).toBe('/openshell.v1.OpenShell/GetProviderCredentials');
  expect(
    rpc
      .requestSerialize({ workspace_scope: { workspace: 'w' }, name: 'n', credential_keys: ['k'] })
      .toString('hex'),
  ).toBe('0a030a017712016e1a016b');
  expect(rpc.responseDeserialize(Buffer.from('0a080a016b12030a0176', 'hex'))).toEqual({
    credentials: { k: { value: 'v' } },
  });
});
it('preserves endpoint declarations for vault-only profile rejection', () => {
  const rpc = openShellSecretService.GetProviderProfile;
  const response = rpc.responseDeserialize(Buffer.from('0a0432020801', 'hex')) as {
    profile: { endpoints: Buffer[] };
  };
  expect(response.profile.endpoints).toHaveLength(1);
});
