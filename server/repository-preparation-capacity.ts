import type Database from 'better-sqlite3';

const MAX_PREPARED_GITHUB_SOURCES = 8;
export class RepositoryPreparationCapacityError extends Error {
  constructor() {
    super(
      'This account already has eight retained GitHub repository preparations. Retire an unused preparation before creating another.',
    );
  }
}
/** Local source custody and retained task history do not consume managed GitHub source slots.
 * Call inside the same immediate transaction that reserves the incoming preview. */
export function assertGithubPreparationCapacity(db: Database.Database, accountId: string) {
  const row = db
    .prepare(
      `
    SELECT COUNT(*) AS count FROM repository_workspaces
    WHERE json_extract(record, '$.binding.accountId') = ?
      AND json_extract(record, '$.localSource') IS NULL
      AND json_extract(record, '$.state') IN ('preparing','ready','reserved','claiming','claimed')
      AND COALESCE(json_extract(record, '$.sourceReleased'), 0) = 0
  `,
    )
    .get(accountId) as { count: number };
  if (row.count >= MAX_PREPARED_GITHUB_SOURCES) throw new RepositoryPreparationCapacityError();
}
