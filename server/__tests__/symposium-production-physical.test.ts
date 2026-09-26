import { describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  LocalSymposiumProductionPhysicalProof,
  digestSymposiumPublicProfile,
} from '../symposium-production-physical.js';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const profile = { id: 'openai', credentials: [{ name: 'key' }] };
const instance = { name: 'seat-account', id: 'account-id', type: 'openai', workspace: 'workspace' };
const binding = {
  ...instance,
  profileName: 'openai',
  profileSha256: digestSymposiumPublicProfile(profile),
};
function setup(invoke?: (args: readonly string[]) => string) {
  const custody = vi.fn();
  const run = vi.fn((_exe: string, args: readonly string[]) =>
    invoke
      ? invoke(args)
      : JSON.stringify(
          args[0] === 'profile' ? profile : { providers: [instance], next_page_token: '' },
        ),
  );
  const proof = new LocalSymposiumProductionPhysicalProof(
    {
      cli: '/bin/openshell',
      podman: '/bin/podman',
      cliEnv: { HOME: '/private/home', XDG_CONFIG_HOME: '/private/config', PATH: '/usr/bin:/bin' },
      podmanEnv: { PATH: '/usr/bin:/bin' },
      ownedGateway: {
        gateway: 'owned',
        workspace: 'workspace',
        endpoint: 'https://127.0.0.1:12345',
        verifyGatewayDriverConfig: custody,
      },
    },
    run,
  );
  return { proof, run, custody };
}
describe('host physical production proof', () => {
  it('canonicalizes public profile object keys without reordering arrays', () => {
    expect(digestSymposiumPublicProfile({ credentials: profile.credentials, id: 'openai' })).toBe(
      binding.profileSha256,
    );
    expect(digestSymposiumPublicProfile({ id: 'openai', values: [1, 2] })).not.toBe(
      digestSymposiumPublicProfile({ id: 'openai', values: [2, 1] }),
    );
  });
  it('attests public provider binding with explicit TLS route and fresh custody', () => {
    const { proof, run, custody } = setup();
    proof.verifyProviderInstance(binding);
    expect(custody).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][1]).toContain('--gateway');
    expect(run.mock.calls[1][1]).not.toContain('--gateway-insecure');
  });
  it('rejects type/profile divergence and duplicate identity across pages', () => {
    expect(() =>
      setup().proof.verifyProviderInstance({ ...binding, profileName: 'other' }),
    ).toThrow();
    const { proof } = setup((args) =>
      JSON.stringify(
        args[0] === 'profile' ? profile : { providers: [instance, instance], next_page_token: '' },
      ),
    );
    expect(() => proof.verifyProviderInstance(binding)).toThrow('binding');
  });
  it('rejects repeated pagination tokens', () => {
    const { proof } = setup((args) =>
      JSON.stringify(
        args[0] === 'profile' ? profile : { providers: [], next_page_token: 'repeat' },
      ),
    );
    expect(() => proof.verifyProviderInstance(binding)).toThrow('pagination');
  });
  it('copies controller from an immutable never-started container and always removes it', () => {
    const { proof, run } = setup((args) => {
      if (args[0] === 'image')
        return JSON.stringify([{ Id: sha('image-id'), Digest: `sha256:${sha('image')}` }]);
      if (args[0] === 'cp') writeFileSync(args[2], 'controller');
      return '';
    });
    proof.verifyImageAndController(
      'runtime',
      sha('image'),
      '/usr/bin/controller',
      sha('controller'),
    );
    expect(run.mock.calls.map((call) => call[1][0])).toEqual(['image', 'create', 'cp', 'rm']);
    expect(run.mock.calls[1][1]).toContain('--network=none');
    expect(() =>
      proof.verifyImageAndController('runtime', sha('image'), '/usr/bin/controller', sha('wrong')),
    ).toThrow('controller');
    expect(run.mock.calls.at(-1)?.[1][0]).toBe('rm');
  });
  it('requires exact physical volume labels and no bind options', () => {
    const volume = {
      Name: 'artifacts',
      Driver: 'local',
      Options: {},
      Labels: {
        'mitzo.symposium.purpose': 'artifacts',
        'mitzo.symposium.session': 'session',
        'mitzo.symposium.workspace': 'workspace',
        'mitzo.symposium.generation': 'generation',
        'openshell.ai/sandbox-attachable': 'true',
        'openshell.ai/sandbox-attachable-workspace': 'workspace',
      },
    };
    const { proof } = setup(() => JSON.stringify([volume]));
    proof.verifyArtifactVolume('podman', 'artifacts', 'workspace');
    volume.Options = { device: '/host' };
    expect(() => proof.verifyArtifactVolume('podman', 'artifacts', 'workspace')).toThrow(
      'admission',
    );
  });
  it('copies every native artifact from physical image bytes and rejects any digest drift', () => {
    const paths = [
      '/usr/bin/codex',
      '/usr/local/bin/symposium-attempt-controller',
      '/usr/local/bin/symposium-seat-landlock',
      '/usr/local/bin/symposium-subscription-app-server',
    ];
    const { proof, run } = setup((args) => {
      if (args[0] === 'image')
        return JSON.stringify([{ Id: sha('image-id'), Digest: `sha256:${sha('image')}` }]);
      if (args[0] === 'cp') writeFileSync(args[2], args[1].split(':').slice(1).join(':'));
      return '';
    });
    const artifacts = Object.fromEntries(paths.map((path) => [path, sha(path)]));
    proof.verifyNativeArtifacts('runtime', sha('image'), artifacts);
    expect(run.mock.calls.filter((call) => call[1][0] === 'cp')).toHaveLength(4);
    expect(run.mock.calls.some((call) => ['start', 'run', 'exec'].includes(call[1][0]))).toBe(
      false,
    );
    expect(() =>
      proof.verifyNativeArtifacts('runtime', sha('image'), {
        ...artifacts,
        [paths[2]]: sha('changed'),
      }),
    ).toThrow('controller digest changed');
    expect(run.mock.calls.at(-1)?.[1][0]).toBe('rm');
  });
  it('cannot infer owned native custody from a legacy gateway policy verifier', () => {
    const { proof } = setup();
    expect(() =>
      proof.verifyOwnedNativeHost({
        cli: '/bin/openshell',
        cliEnvironment: {
          HOME: '/private/home',
          XDG_CONFIG_HOME: '/private/config',
          PATH: '/usr/bin:/bin',
        },
        cliSha256: sha('cli'),
        gatewaySha256: sha('gateway'),
        gateway: 'owned',
        workspace: 'workspace',
        gatewayEndpoint: 'https://127.0.0.1:12345',
        image: 'image',
        sandboxRuntimeImage: 'runtime',
        supervisorImage: 'supervisor',
      }),
    ).toThrow('unavailable');
  });
});
