/** Private offline HTTP test process. Never imported by the application. */
import { app, taskStore } from '../../app.js';
import { eventStore } from '../../chat.js';
const server = app.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Private App address unavailable');
  process.send?.({ ready: true, pid: process.pid, port: address.port });
});
process.on('message', (message) => {
  if (message !== 'close-private-app') return;
  server.close(() => {
    taskStore.close();
    eventStore.close();
    process.exit(0);
  });
});
