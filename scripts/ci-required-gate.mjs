import process from 'node:process';
import console from 'node:console';
const needs = JSON.parse(process.env.CI_REQUIRED_NEEDS ?? '{}');
for (const name of [
  'changes',
  'core',
  'unit-validation',
  'ordinary-journey',
  'joined-validation',
  'ordinary-supplemental',
  'browser-validation',
]) {
  if (needs[name]?.result !== 'success') {
    console.error('Required CI owner incomplete: ' + name);
    process.exit(1);
  }
}
const selectedNative = needs.changes.outputs?.native;
if (
  !['true', 'false'].includes(selectedNative) ||
  needs.native?.result !== (selectedNative === 'true' ? 'success' : 'skipped')
) {
  console.error('Selected native CI owner incomplete or selection unavailable');
  process.exit(1);
}
