import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

const path = new URL('../../docs/spikes/openshell-codex/symposium-claude-vertex', import.meta.url);
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
it('fixed Claude launcher validates projection and strips inherited auth endpoints before exact native exec', () => {
  const source = readFileSync(path, 'utf8');
  expect(source).toContain('exec /usr/local/bin/claude "$@"');
  expect(source).not.toContain('exec "$@"');
  // Replace only the fixed native executable in this in-memory test copy. No native inference.
  const script = source.replace(
    'exec /usr/local/bin/claude "$@"',
    `exec ${quote(process.execPath)} -e ${quote('process.stdout.write(JSON.stringify({project:process.env.ANTHROPIC_VERTEX_PROJECT_ID,region:process.env.CLOUD_ML_REGION,auth:process.env.ANTHROPIC_AUTH_TOKEN,key:process.env.ANTHROPIC_API_KEY,adc:process.env.GOOGLE_APPLICATION_CREDENTIALS,base:process.env.ANTHROPIC_BASE_URL,vbase:process.env.ANTHROPIC_VERTEX_BASE_URL,header:process.env.ANTHROPIC_CUSTOM_HEADERS,regionOverride:process.env.VERTEX_REGION_CLAUDE_HAIKU_4_5,modelOverride:process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,effortOverride:process.env.CLAUDE_CODE_EFFORT_LEVEL,otherProvider:process.env.CLAUDE_CODE_USE_BEDROCK}))')}`,
  );
  const base = {
    VERTEX_AI_PROJECT_ID: 'project-1',
    VERTEX_AI_REGION: 'global',
    GOOGLE_VERTEX_AI_TOKEN: 'openshell:resolve:env:GOOGLE_VERTEX_AI_TOKEN',
  };
  const run = (env: Record<string, string>) =>
    spawnSync('/bin/sh', ['-eu', '-c', script, '--', 'project-1', 'global', '--version'], {
      encoding: 'utf8',
      env,
    });
  const result = run({
    ...base,
    ANTHROPIC_AUTH_TOKEN: 'dummy',
    VERTEX_REGION_CLAUDE_HAIKU_4_5: 'other-region',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'other-model',
    CLAUDE_CODE_EFFORT_LEVEL: 'high',
    CLAUDE_CODE_USE_BEDROCK: '1',
    ANTHROPIC_API_KEY: 'dummy',
    GOOGLE_APPLICATION_CREDENTIALS: 'dummy',
    ANTHROPIC_BASE_URL: 'dummy',
    ANTHROPIC_VERTEX_BASE_URL: 'dummy',
  });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    project: 'project-1',
    region: 'global',
    header: 'Authorization: Bearer openshell:resolve:env:GOOGLE_VERTEX_AI_TOKEN',
  });
  for (const changed of [
    { GOOGLE_VERTEX_AI_TOKEN: '' },
    { GOOGLE_VERTEX_AI_TOKEN: 'dummy-raw' },
    { GOOGLE_VERTEX_AI_TOKEN: 'openshell:resolve:env:v1x_GOOGLE_VERTEX_AI_TOKEN' },
    {
      GOOGLE_VERTEX_AI_TOKEN: 'openshell:resolve:env:v1\r\nOther: injected_GOOGLE_VERTEX_AI_TOKEN',
    },
    {
      GOOGLE_VERTEX_AI_TOKEN:
        'openshell:resolve:env:v' + '1'.repeat(200) + '_GOOGLE_VERTEX_AI_TOKEN',
    },
    { GOOGLE_VERTEX_AI_TOKEN: 'openshell:resolve:env:OTHER' },
    { VERTEX_AI_PROJECT_ID: 'other' },
    { VERTEX_AI_REGION: 'other' },
    {
      GOOGLE_VERTEX_AI_SERVICE_ACCOUNT_TOKEN:
        'openshell:resolve:env:GOOGLE_VERTEX_AI_SERVICE_ACCOUNT_TOKEN',
    },
  ])
    expect(run({ ...base, ...changed }).status).toBe(64);
});

it.each(['1x', '1\r\nOther: injected', '1'.repeat(200), '', '1_2'])(
  'rejects malformed or oversized placeholder version %j before exec',
  (version) => {
    const script = readFileSync(path, 'utf8').replace(
      'exec /usr/local/bin/claude "$@"',
      'exec /usr/bin/true',
    );
    const result = spawnSync(
      '/bin/sh',
      ['-eu', '-c', script, '--', 'project-1', 'global', '--version'],
      {
        env: {
          VERTEX_AI_PROJECT_ID: 'project-1',
          VERTEX_AI_REGION: 'global',
          GOOGLE_VERTEX_AI_TOKEN: `openshell:resolve:env:v${version}_GOOGLE_VERTEX_AI_TOKEN`,
        },
      },
    );
    expect(result.status).toBe(64);
  },
);
