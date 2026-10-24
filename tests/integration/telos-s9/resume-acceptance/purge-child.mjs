// Private offline App process. No file-family creation/enrollment or host service
// startup occurs here; original constructors inspect the caller-created files.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const root = process.cwd();
register(new URL('../coherent-final-preparation/coherent-child-loader.mjs', import.meta.url), {
  data: { root },
});
globalThis.fetch = async () => {
  throw Error('No external provider/network effects in private purge App');
};
const source = (relative) => import(pathToFileURL(join(root, relative)).href);
const application = await source('server/app.ts'),
  chat = await source('server/chat.ts'),
  auth = await source('server/auth.ts');
auth.setAuthRevocationStore(chat.eventStore);
const server = application.app.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string' || [3100, 3101, 3190].includes(address.port))
    throw Error('Private owned IPv4 listener required');
  process.send?.({ type: 'ready', pid: process.pid, port: address.port });
});
process.on('message', async (message) => {
  if (message?.type !== 'close-private-purge-app') return;
  try {
    await new Promise((done, reject) => server.close((error) => (error ? reject(error) : done())));
    if (message.final) {
      const current = await auth.authenticateToken(message.token);
      if (!current) throw Error('Original signed operator required for final release');
      auth.revokeAuthSession(current);
      if ((await auth.authenticateToken(message.token)) !== null)
        throw Error('Final operator revocation not retained');
      if (!process.send) throw Error('Owned parent IPC required for final auth release');
      await new Promise((done, reject) =>
        process.send({ type: 'auth-revoked', operatorId: current.id, confirmed: true }, (error) =>
          error ? reject(error) : done(),
        ),
      );
    }
    application.taskStore.close();
    chat.eventStore.close();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
});
