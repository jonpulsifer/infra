/**
 * `getAppSource`: the repository, subpath and config file one App builds from.
 * Kept out of the polled workspace read because it calls the repository host.
 * The file is read at the adopted commit, whose config is the one in effect.
 */
import { z } from 'zod';
import type { RepositoryHost } from '../../domain/repository.ts';
import { repositoryRefOf } from '../../domain/repository.ts';
import { SPINDRIFT_FILE } from '../../integrations/github/config-pr.ts';
import { type Command, failed, ok } from '../types.ts';
import type { AppManifestView, AppSourceView } from '../views.ts';

export const getAppSourceInput = z
  .object({
    /** The App, by name or by id. */
    app: z.string().min(1),
  })
  .strict();
export type GetAppSourceInput = z.infer<typeof getAppSourceInput>;

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
  // An archive App has no repository, subpath or config file.
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
 * The config file, or why it could not be read. It never throws, so a
 * repository host outage cannot fail the command.
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
