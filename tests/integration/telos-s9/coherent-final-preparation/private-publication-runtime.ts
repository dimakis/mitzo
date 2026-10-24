import { isAbsolute, relative, sep } from 'node:path';
import { CredentialResolver } from '../../../../server/credentials.js';
import {
  PublicationCredentialCustodian,
  type PublicationCommandRunner,
} from '../../../../server/symposium-publication-credentials.js';
import {
  installTelosMainPublicationRuntime,
  type TelosMainPublicationRuntime,
} from '../../../../server/telos-main-publication-runtime.js';
import type { GithubMainMergeRegistration } from '../../../../server/github-main-merge-selection.js';
import type { fixture } from '../../../../server/__tests__/fixtures/github-main-publication.js';

type RuntimeOwners = ConstructorParameters<typeof TelosMainPublicationRuntime>[0];
/** Install the REAL registration/selection/custodian/runtime for a private App.
 * The existing 1048 fixture supplies external GitHub run/state ONLY. Never pass
 * its pins, adapter, dispatchMerge, permit or a constructed native context here.
 * Real Codex callback and host one-use permission still own every future call. */
export function installPrivatePublicationTransport(
  owners: Pick<RuntimeOwners, 'events' | 'registry' | 'databasePath'>,
  input: {
    privateCanonicalRoot: string;
    registration: Omit<GithubMainMergeRegistration, 'credentialRef'>;
    external: Pick<ReturnType<typeof fixture>, 'run'>;
    record(stage: string, facts: Record<string, unknown>): Promise<void>;
  },
) {
  const database = owners.databasePath();
  const inside = relative(input.privateCanonicalRoot, database);
  if (
    !isAbsolute(input.privateCanonicalRoot) ||
    !isAbsolute(database) ||
    inside === '..' ||
    inside.startsWith('..' + sep) ||
    isAbsolute(inside)
  )
    throw Error('Selected private canonical root required');
  const reference = {
    provider: 's9fixture',
    service: 'offline-github',
    account: 'synthetic-publisher',
  };
  const resolver = new CredentialResolver({
    s9fixture: {
      async resolve(value) {
        if (JSON.stringify(value) !== JSON.stringify(reference))
          throw Error('Only synthetic fixture credential lookup is allowed');
        return 'offline-s9-github-transport-only';
      },
    },
  });
  const runner: PublicationCommandRunner = async (
    command,
    args,
    signal,
    _environment,
    prepareDispatch,
  ) => {
    if (command !== 'gh') throw Error('Only selected fake external GitHub transport is allowed');
    // Preserve the real custodian's final synchronous admission at the external
    // effect boundary, after any asynchronous command preparation.
    const admit = prepareDispatch ? await prepareDispatch() : undefined;
    signal.throwIfAborted();
    const mutation = args.includes('PUT') || args.some((arg) => arg.includes('mergePullRequest('));
    if (mutation && !admit)
      throw Error('Fake external mutation requires the real final dispatch boundary');
    const result = await input.external.run(command, args, signal, admit);
    try {
      await input.record('actual-owned-publication-external-transport-response', {
        command,
        args,
        mutationDispatchBoundaryPresent: admit !== undefined,
        stdout: result.stdout,
        noEnvironmentOrCredentialCaptured: true,
      });
    } catch {
      /* A diagnostic sink must not erase a known external response. */
    }
    return { stdout: result.stdout };
  };
  return installTelosMainPublicationRuntime({
    ...owners,
    databasePath: () => database,
    registrations: [{ ...input.registration, credentialRef: reference }],
    custodian: new PublicationCredentialCustodian(resolver, runner),
  });
}
