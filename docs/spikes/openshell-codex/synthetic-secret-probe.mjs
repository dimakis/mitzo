import { readFileSync } from 'node:fs';

const canary = 'synthetic-access-token-not-real';
const surfaces = [
  Object.entries(process.env).map(([key, value]) => `${key}=${value}`).join('\n'),
  readFileSync('/proc/self/environ').toString(),
];
if (surfaces.some((surface) => surface.includes(canary))) {
  console.log('SYNTHETIC_SECRET_EXPOSED=fail');
  process.exit(1);
}

console.log(
  Object.keys(process.env).some((key) => key.startsWith('CODEX_AUTH_'))
    ? 'SYNTHETIC_PROVIDER_ENV_PRESENT=pass'
    : 'SYNTHETIC_PROVIDER_ENV_ABSENT=pass',
);
console.log('SYNTHETIC_SECRET_LITERAL_UNREADABLE=pass');
