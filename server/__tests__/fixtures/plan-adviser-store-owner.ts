/** Offline process fixture: no host configuration, provider or model calls. */
import { FilePlanAdviserStore } from '../../chatgpt-plan-adviser-store.js';

try {
  const store = new FilePlanAdviserStore(process.argv[2]);
  process.send?.({ ok: true, state: store.load() });
  process.on('message', (message) => {
    if (message === 'close') {
      store.close();
      process.disconnect();
    }
  });
} catch {
  process.send?.({ ok: false }, () => {
    process.exitCode = 1;
    process.disconnect();
  });
}
