/**
 * `getAppSource` — the repository, the scope, and the `spindrift.yaml` that
 * governs how one App is built (§5, §15).
 *
 * Every fact here was already in the database or one file read away, and none
 * of it reached a screen: the workspace knew which Target an App runs on and
 * said nothing about where its code comes from, so "which directory of which
 * repo is this, and is there a Spindrift file in it" was a question answered by
 * opening GitHub.
 *
 * **Its own command rather than more of `getAppWorkspace`.** The manifest arm
 * is a live read against the repository host, and the workspace re-reads itself
 * every two seconds while a release is in flight — folding this in would spend
 * a rate limit on an answer nobody asked for again. The Config tab reads this
 * once when it opens, the way `Releases` fetches its own rows.
 *
 * **Read at the adopted commit, never at the branch head.** §15 makes
 * `authoritative_commit` the configuration Spindrift has actually adopted, so
 * that is the commit whose file is governing right now. Reading the head would
 * show a file that has not taken effect yet as though it had.
 */
import { z } from 'zod';
import type { RepositoryHost } from '../../domain/repository.ts';
import { repositoryRefOf } from '../../domain/repository.ts';
import { SPINDRIFT_FILE } from '../../integrations/github/config-pr.ts';
import { type Command, failed, ok } from '../types.ts';
import type { AppManifestView, AppSourceView } from '../views.ts';

export const getAppSourceInput = z
  .object({
    /** The App, by name or by id — the same handle `getAppWorkspace` takes. */
    app: z.string().min(1),
  })
  .strict();
export type GetAppSourceInput = z.infer<typeof getAppSourceInput>;

/** What the manifest is read against. The stored row, narrowed to what is used. */
interface ConnectedRepository {
  readonly fullName: string;
  readonly installationId: string;
  readonly defaultBranch: string;
  readonly authoritativeCommit: string | null;
}

export const getAppSource: Command<
  GetAppSourceInput,
  { source: AppSourceView | null }
> = async (input, context) => {
  const isUuid = z.string().uuid().safeParse(input.app).success;
  const app = await context.db.query.apps.findFirst({
    where: (apps, { eq, or }) =>
      isUuid
        ? or(eq(apps.name, input.app), eq(apps.id, input.app))
        : eq(apps.name, input.app),
    with: { repository: true },
  });

  if (!app) return failed('NOT_FOUND', `App '${input.app}' not found`);
  // An uploaded archive has no repository, no scope and no Spindrift file, so
  // every field below would be an absence dressed as an answer (§2, §4).
  if (app.sourceKind !== 'repo') return ok({ source: null });

  const subpath = app.sourceRepoSubpath ?? '.';
  const path =
    subpath === '.' ? SPINDRIFT_FILE : `${subpath}/${SPINDRIFT_FILE}`;
  const repository: ConnectedRepository | null = app.repository ?? null;

  return ok({
    source: {
      repo: repository?.fullName ?? app.sourceRepoUrl ?? 'unknown',
      url:
        repository === null
          ? (app.sourceRepoUrl ?? null)
          : `${context.manifest.github.webBaseUrl}/${repository.fullName}`,
      branch: repository?.defaultBranch ?? null,
      subpath,
      commit: repository?.authoritativeCommit ?? null,
      manifest: await manifestAt(
        context.adapters.repository(),
        repository,
        path,
      ),
    },
  });
};

/**
 * The scope's Spindrift file, or the reason there is no answer about it.
 *
 * Nothing here throws and nothing here fails the command. Where this App is
 * built from is a fact Spindrift holds itself; the file is a fact it has to ask
 * someone else for, and a repository host having a bad minute is not a reason
 * to take the rest of the card off the screen.
 */
async function manifestAt(
  host: RepositoryHost | null,
  repository: ConnectedRepository | null,
  path: string,
): Promise<AppManifestView> {
  if (repository === null) {
    return {
      path,
      state: 'unread',
      because: 'No repository is connected to this App, so nothing was read.',
    };
  }
  if (host === null) {
    return {
      path,
      state: 'unread',
      because: 'This installation has no repository integration.',
    };
  }
  const commit = repository.authoritativeCommit;
  if (commit === null) {
    return {
      path,
      state: 'unread',
      because: `No commit on ${repository.defaultBranch} has been adopted yet, so there is no revision to read it at.`,
    };
  }

  let document: string | null;
  try {
    document = await host.readFile(
      repositoryRefOf(repository),
      repository.fullName,
      commit,
      path,
    );
  } catch (cause) {
    return {
      path,
      state: 'unread',
      because: cause instanceof Error ? cause.message : String(cause),
    };
  }

  return document === null
    ? { path, state: 'absent' }
    : { path, state: 'present', text: document };
}
