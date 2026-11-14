// Bounded fixture-only render diagnostics remain inspectable as GitHub check
// annotations even when the separate authenticated log API is unavailable.
function annotate(message) {
  const text = stripVTControlCharacters(message)
    .slice(0, 6000)
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
  process.stdout.write(`::error title=Symposium render acceptance::${text}\n`);
}

export default class SymposiumAcceptanceReporter {
  onTestEnd(test, result) {
    if (['skipped', 'interrupted'].includes(result.status) || result.status === test.expectedStatus)
      return;
    annotate(
      `${test.titlePath().join(' / ')}\n${result.errors.map((error) => error.message ?? error.value ?? 'Unknown render failure').join('\n')}`,
    );
  }

  onError(error) {
    annotate(`render_startup\n${error.message ?? 'Unknown browser startup failure'}`);
  }
}
import process from 'node:process';
import { stripVTControlCharacters } from 'node:util';
