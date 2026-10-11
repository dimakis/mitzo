import { finishAppShutdown } from '../../symposium-app-exit.ts';
import process from 'node:process';
import { setTimeout } from 'node:timers';

// Offline fixture: no app bootstrap, credentials, gateway, provider or model.
process.once('SIGTERM', () => {
  void finishAppShutdown(
    true,
    () => new Promise((resolve) => setTimeout(resolve, 250)),
    () => process.exit(0),
  );
});
process.send({ ready: true });
