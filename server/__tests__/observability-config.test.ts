import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import yaml from 'js-yaml';
import { stageObservabilityConfig } from '../../scripts/observability-config.mjs';
import { mkdtempSync, rmSync, existsSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '../..');

describe('observability stack config', () => {
  const EXPECTED_SERVICES = ['jaeger', 'loki', 'grafana', 'mlflow'];

  it('docker-compose.yml defines all expected services', () => {
    const compose = readFileSync(resolve(ROOT, 'docker-compose.yml'), 'utf-8');
    for (const svc of EXPECTED_SERVICES) {
      expect(compose).toContain(`  ${svc}:`);
    }
  });

  it('ensure-observability.sh verifies all expected services', () => {
    const script = readFileSync(resolve(ROOT, 'scripts/ensure-observability.sh'), 'utf-8');
    for (const svc of EXPECTED_SERVICES) {
      expect(script).toContain(svc);
    }
  });

  it('uses release-independent named storage and explicit service ownership', () => {
    const compose = yaml.load(readFileSync(resolve(ROOT, 'docker-compose.yml'), 'utf8')) as {
      services: Record<
        string,
        { volumes: string[]; image: string; environment: Record<string, string>; command: string[] }
      >;
      volumes: Record<string, unknown>;
      'x-podman': { in_pod: boolean };
    };
    for (const svc of EXPECTED_SERVICES) {
      expect(compose.services[svc].volumes.some((v: string) => v.startsWith(`${svc}-data:`))).toBe(
        true,
      );
      for (const mount of compose.services[svc].volumes)
        if (mount.includes('MITZO_OBSERVABILITY_CONFIG_DIR'))
          expect(mount.endsWith(':ro')).toBe(true);
      expect(compose.volumes[`${svc}-data`]).toEqual({ external: true, name: `mitzo-${svc}-data` });
    }
    expect(compose['x-podman'].in_pod).toBe(false);
    expect(compose.services.jaeger.image).toBe('jaegertracing/jaeger:2.20.0');
    expect(compose.services.grafana.environment.GF_FEATURE_TOGGLES_ENABLE).toBe('');
    expect(compose.services.grafana.environment.GF_PLUGINS_PREINSTALL_SYNC).toBe(
      'jaeger@13.0.8,loki@13.2.5',
    );
    expect(compose.services.mlflow.command).toContain('--artifacts-destination');
    expect(compose.services.mlflow.command).toContain('mlflow-artifacts:/');
  });

  it('deployment uses the shared startup and real readback check', () => {
    const ensure = readFileSync(resolve(ROOT, 'scripts/ensure-observability.sh'), 'utf8');
    const deploy = readFileSync(resolve(ROOT, 'scripts/deploy.sh'), 'utf8');
    expect(ensure).toContain('observability-readback.mjs');
    expect(ensure).not.toContain('machine start 2>&1 || true');
    expect(deploy).toContain('./scripts/ensure-observability.sh');
    expect(deploy).not.toContain('docker compose -p mitzo up -d');
  });

  it('stages immutable configs outside the disposable source release', () => {
    const state = mkdtempSync(resolve(tmpdir(), 'mitzo-observability-'));
    try {
      const staged = stageObservabilityConfig(ROOT, state);
      expect(staged).not.toContain(ROOT);
      expect(stageObservabilityConfig(ROOT, state)).toBe(staged);
      expect(existsSync(resolve(staged, 'infra/loki-config.yaml'))).toBe(true);
      const custom = stageObservabilityConfig(ROOT, state, {
        jaegerUiUrl: 'https://observability.example/jaeger',
        mlflowUiUrl: 'https://observability.example/mlflow',
      });
      expect(custom).not.toBe(staged);
      expect(
        readFileSync(
          resolve(custom, 'infra/grafana/provisioning/dashboards/json/mitzo-observability.json'),
          'utf8',
        ),
      ).toContain('https://observability.example/jaeger/search?service=mitzo');
      writeFileSync(resolve(staged, 'infra/grafana/provisioning/unreviewed.yaml'), 'apiVersion: 1');
      expect(() => stageObservabilityConfig(ROOT, state)).toThrow('OBSERVABILITY_CONFIG_INTEGRITY');
      rmSync(resolve(staged, 'infra/grafana/provisioning/unreviewed.yaml'));
      symlinkSync(
        resolve(ROOT, 'infra/loki-config.yaml'),
        resolve(staged, 'infra/grafana/provisioning/linked.yaml'),
      );
      expect(() => stageObservabilityConfig(ROOT, state)).toThrow('UNSAFE_OBSERVABILITY_CONFIG');
      expect(
        existsSync(resolve(staged, 'infra/grafana/provisioning/datasources/datasources.yaml')),
      ).toBe(true);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  it('binds every dashboard query to explicit correlated data sources', () => {
    const sources = yaml.load(
      readFileSync(
        resolve(ROOT, 'infra/grafana/provisioning/datasources/datasources.yaml'),
        'utf8',
      ),
    ) as {
      datasources: Array<{
        type: string;
        uid: string;
        jsonData?: {
          tracesToLogsV2?: { datasourceUid: string };
          derivedFields?: Array<{ matcherRegex: string }>;
        };
      }>;
    };
    expect(sources.datasources.find((source) => source.type === 'loki')?.uid).toBe(
      'P8E80F9AEF21F6940',
    );
    expect(
      sources.datasources.find((source) => source.type === 'jaeger')?.jsonData?.tracesToLogsV2
        ?.datasourceUid,
    ).toBe('P8E80F9AEF21F6940');
    const matcher = sources.datasources.find((source) => source.type === 'loki')?.jsonData
      ?.derivedFields?.[0].matcherRegex;
    expect(matcher).toBeTruthy();
    expect(new RegExp(matcher!).exec('{"trace_id":"' + 'a'.repeat(32) + '"}')?.[1]).toBe(
      'a'.repeat(32),
    );
    const dashboard = JSON.parse(
      readFileSync(
        resolve(ROOT, 'infra/grafana/provisioning/dashboards/json/mitzo-observability.json'),
        'utf8',
      ),
    );
    for (const panel of dashboard.panels)
      if (panel.datasource)
        expect(panel.datasource.uid).toBe(
          panel.datasource.type === 'loki' ? 'P8E80F9AEF21F6940' : 'jaeger',
        );
  });

  it('keeps Jaeger self-tracing on an internal receiver', () => {
    const config = yaml.load(
      readFileSync(resolve(ROOT, 'infra/jaeger-v2-config.yaml'), 'utf8'),
    ) as { receivers: { otlp: { protocols: { grpc?: { endpoint: string } } } } };
    expect(config.receivers.otlp.protocols.grpc?.endpoint).toBe('127.0.0.1:4317');
  });

  it('offers trace discovery through supported Jaeger search and correlated logs', () => {
    const dashboard = JSON.parse(
      readFileSync(
        resolve(ROOT, 'infra/grafana/provisioning/dashboards/json/mitzo-observability.json'),
        'utf8',
      ),
    );
    expect(
      dashboard.panels
        .flatMap((panel: { targets?: Array<{ queryType?: string }> }) => panel.targets ?? [])
        .some((query: { queryType?: string }) => query.queryType === 'search'),
    ).toBe(true);
    expect(dashboard.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Search traces',
          url: 'http://localhost:16686/search?service=mitzo',
        }),
      ]),
    );
  });

  it('runs both startup modes on the host shell and refuses stopped unmigrated storage', () => {
    const state = mkdtempSync(resolve(tmpdir(), 'mitzo-observability-shell-'));
    try {
      const calls = resolve(state, 'calls');
      const podman = resolve(state, 'podman');
      writeFileSync(
        podman,
        `#!/bin/sh
printf '%s\n' "$*" >> "$CALLS"
case "$1 $2" in
  'machine inspect') echo running;;
  'container exists') [ "$LEGACY" = true ];;
  'inspect --format') if [ "$LEGACY" = true ]; then echo exited; else exit 1; fi;;
  'volume exists') [ "$LEGACY" != true ];;
esac
`,
        { mode: 0o755 },
      );
      writeFileSync(
        resolve(state, 'node'),
        `#!/bin/sh
case "$1" in
  *observability-config.mjs) echo "$STATE";;
  *observability-readback.mjs) echo "readback $*" >> "$CALLS";;
esac
`,
        { mode: 0o755 },
      );
      const env = {
        ...process.env,
        PODMAN: podman,
        MITZO_OBSERVABILITY_HOME: state,
        PATH: state + ':' + process.env.PATH,
        CALLS: calls,
        STATE: state,
      };
      const script = resolve(ROOT, 'scripts/ensure-observability.sh');
      for (const args of [[], ['--traces-only']]) {
        writeFileSync(calls, '');
        const result = spawnSync('/bin/bash', [script, ...args], { env, encoding: 'utf8' });
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(calls, 'utf8')).toContain('readback ');
      }
      writeFileSync(calls, '');
      const refused = spawnSync('/bin/bash', [script], {
        env: { ...env, LEGACY: 'true' },
        encoding: 'utf8',
      });
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('data-preserving migration');
      expect(readFileSync(calls, 'utf8')).not.toMatch(/volume create|compose/);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  it('gitignore covers all compose data volumes', () => {
    const gitignore = readFileSync(resolve(ROOT, '.gitignore'), 'utf-8');
    const compose = readFileSync(resolve(ROOT, 'docker-compose.yml'), 'utf-8');
    // Extract volume mount patterns like ./.foo-data (anchored to colon boundary)
    const volumeMatches = compose.match(/\.\/\.\w[\w-]*data\b/g) || [];
    for (const vol of volumeMatches) {
      const dirName = vol.replace('./', '') + '/';
      expect(gitignore).toContain(dirName);
    }
  });

  it('docker-compose.yml exposes expected ports', () => {
    const compose = readFileSync(resolve(ROOT, 'docker-compose.yml'), 'utf-8');
    const expectedPorts = ['4318', '16686', '3200', '3002', '5050'];
    for (const port of expectedPorts) {
      expect(compose).toContain(port);
    }
  });
});
