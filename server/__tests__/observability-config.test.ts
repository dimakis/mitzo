import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

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
    const script = readFileSync(
      resolve(ROOT, 'scripts/ensure-observability.sh'),
      'utf-8',
    );
    for (const svc of EXPECTED_SERVICES) {
      expect(script).toContain(svc);
    }
  });

  it('ensure-observability.sh uses flexible container name matching', () => {
    const script = readFileSync(
      resolve(ROOT, 'scripts/ensure-observability.sh'),
      'utf-8',
    );
    // Should use --filter pattern, not hardcoded _svc_1 names in commands
    expect(script).toContain('--filter');
    // Actual container references use dynamic filter, not hardcoded names
    expect(script).not.toMatch(/\$\{?PODMAN\}?.*mitzo_\w+_1/);
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
