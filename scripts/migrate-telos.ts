import { migrateTelosDatabase } from '../server/telos-migration.js';

const [confirmation, source, destination, ...extra] = process.argv.slice(2);
if (confirmation !== '--offline' || !source || !destination || extra.length) {
  process.stderr.write(
    'Stop Mitzo and legacy Telos writers, then run: tsx scripts/migrate-telos.ts --offline SOURCE DESTINATION\n',
  );
  process.exitCode = 1;
} else {
  try {
    process.stdout.write(
      JSON.stringify(await migrateTelosDatabase(source, destination), null, 2) + '\n',
    );
  } catch (error) {
    process.stderr.write(
      (error instanceof Error ? error.message : 'Telos migration failed') + '\n',
    );
    process.exitCode = 1;
  }
}
