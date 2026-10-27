import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

/** Test-child ownership only. Protected CLI workers are detached from the App;
 * its exit alone does not prove that their fixture files are no longer in use. */
export function observeJoinedFixtureProcesses() {
  const originalSpawn = childProcess.spawn;
  const active = new Set();
  let closing = false;
  childProcess.spawn = function (...args) {
    if (closing) throw Error('Fixture process owner is closing');
    const child = originalSpawn.apply(this, args);
    const closed = new Promise((done) => child.once('close', done));
    active.add(closed);
    void closed.then(() => active.delete(closed));
    return child;
  };
  syncBuiltinESMExports();
  const join = async () => {
    while (active.size) await Promise.all([...active]);
  };
  return {
    join,
    async close() {
      closing = true;
      await join();
    },
    restore() {
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
    },
  };
}
