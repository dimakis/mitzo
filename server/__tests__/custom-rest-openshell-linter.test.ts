import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { connectionTemplateRegistry } from '../connections/registry.js';
import { renderCustomRestProfile } from '../connections-gateway.js';

// This is deliberately the locally pinned production CLI, not the gateway
// CommandRunner mock. It proves the deterministic compiler output remains a
// profile format the deployed OpenShell validator understands.
const openshell = process.env.MITZO_OPENSHELL_CLI ?? '/opt/homebrew/bin/openshell';

describe('custom REST OpenShell profile golden', () => {
  it.skipIf(!existsSync(openshell))(
    'round-trips through the pinned OpenShell profile linter',
    () => {
      const policy = connectionTemplateRegistry.compileProviderPolicy({
        templateId: 'custom-rest-readonly',
        templateVersion: 1,
        fields: {
          endpoint: 'https://api.example.com',
          port: '443',
          protocol: 'rest',
          methods: ['GET', 'HEAD'],
          paths: ['/v1/items'],
          credentialStyle: 'bearer-token',
          credentialLocation: 'header',
          credentialName: 'authorization',
          binaries: ['curl', 'jq'],
          attachmentMode: 'on-demand',
          // In production this is supplied only by gateway-side DNS pinning.
          dnsPin: ['1.1.1.1', '2606:4700:4700::1111'],
        },
      });
      const generated = renderCustomRestProfile(policy);
      const dir = mkdtempSync(join(tmpdir(), 'mitzo-custom-rest-lint-'));
      const profile = join(dir, `${generated.id}.yaml`);
      try {
        writeFileSync(profile, generated.yaml, { encoding: 'utf8', mode: 0o600 });
        const lint = spawnSync(openshell, ['provider', 'profile', 'lint', '--file', profile], {
          encoding: 'utf8',
          timeout: 30_000,
        });
        expect(lint.error).toBeUndefined();
        expect(lint.status, `${lint.stdout}\n${lint.stderr}`).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
