import process from 'node:process';
import console from 'node:console';
const needs = JSON.parse(process.env.CI_REQUIRED_NEEDS ?? '{}');
for (const name of [
  'changes',
  'preflight',
  'frontend-build',
  'core',
  'unit-validation',
  'joined-validation',
  'browser-validation',
]) {
  if (needs[name]?.result !== 'success') {
    console.error('Required CI owner incomplete: ' + name);
    process.exit(1);
  }
}
// Draft runs deselect every expensive owner; anything else is an inconsistent selection.
const draft = needs.changes.outputs?.draft;
if (
  !['true', 'false'].includes(draft) ||
  (draft === 'true' &&
    ['browser', 'native', 'prepared', 'ordinary'].some(
      (owner) => needs.changes.outputs?.[owner] !== 'false',
    ))
) {
  console.error('Draft selection unavailable or inconsistent with selected owners');
  process.exit(1);
}

const selectedNative = needs.changes.outputs?.native;
if (
  !['true', 'false'].includes(selectedNative) ||
  needs.native?.result !== (selectedNative === 'true' ? 'success' : 'skipped')
) {
  console.error('Selected native CI owner incomplete or selection unavailable');
  process.exit(1);
}

const selectedPrepared = needs.changes.outputs?.prepared;
if (
  !['true', 'false'].includes(selectedPrepared) ||
  needs['prepared-consumer-validation']?.result !== 'success'
) {
  console.error('Selected composed prepared consumer owner incomplete or selection unavailable');
  process.exit(1);
}

const selectedOrdinary = needs.changes.outputs?.ordinary;
if (
  !['true', 'false'].includes(selectedOrdinary) ||
  ['ordinary-journey', 'ordinary-supplemental'].some(
    (name) => needs[name]?.result !== (selectedOrdinary === 'true' ? 'success' : 'skipped'),
  )
) {
  console.error('Selected ordinary CI owners incomplete or selection unavailable');
  process.exit(1);
}
