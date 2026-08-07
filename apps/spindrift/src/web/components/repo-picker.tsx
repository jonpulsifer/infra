/**
 * The repository picker for the creation flow's Source step (§20, Task 24).
 *
 * **It lists the grant, not the database.** `listRepositories` answers with two
 * lists on one response — the durable connections Spindrift holds rows for, and
 * the repositories GitHub currently grants this installation — and a picker
 * showing only the first is a picker that reads "No repositories available" on
 * a fresh install where the operator has already granted five. So the two are
 * merged here, and every row says which of the three it is, because they are
 * three different things to press: one already has an App deploying from it,
 * one is connected and has none, and one is offered by GitHub and connects when
 * the App is created.
 *
 * Selecting writes nothing either way. Reading a repository is
 * `inspectRepository`, which writes nothing at all; Deploy is the committing
 * act, and it is there that a grant-only repository gets its row and its
 * configuration pull request.
 *
 * The filter is a client-side substring match against fullName. It is fast
 * enough for the single-operator scale v1 targets, and the picker never
 * fetches — the lists arrive as props from the same API call that populated the
 * creation flow.
 */
import { GitBranch, Search } from 'lucide-react';
import { useState } from 'react';
import type { GrantedRepositoryView, RepositoryOptionView } from '../model.ts';
import { Badge } from '../ui/badge.tsx';
import { cn } from '../ui/utils.ts';

/** What one row is, in the operator's terms. */
export type RepositoryChoiceState =
  /** An App already deploys from it. */
  | 'deploys'
  /** Spindrift holds a row for it and nothing deploys from it yet. */
  | 'connected'
  /** GitHub grants it and Spindrift holds no row: Deploy connects it. */
  | 'grant-only';

/** One repository, as a row an operator can read the state of. */
export interface RepositoryChoice {
  readonly fullName: string;
  readonly defaultBranch: string;
  /** Carried from the response rather than templated: the host is the
   * installation's, and this component has no way to know it. */
  readonly cloneUrl: string;
  readonly state: RepositoryChoiceState;
}

const STATE_BADGE = {
  deploys: { tone: 'success', label: 'already deploys' },
  connected: { tone: 'accent', label: 'connected' },
  'grant-only': { tone: 'idle', label: 'connects on Deploy' },
} as const satisfies Record<
  RepositoryChoiceState,
  { tone: 'success' | 'accent' | 'idle'; label: string }
>;

/**
 * The grant and the connections, as one list.
 *
 * A connection knows whether an App deploys from it and a grant entry knows
 * whether a row exists, which are two different facts about two different
 * lists — so a row's state is derived from which list it came from and the
 * fact that list actually holds, and neither boolean is ever read off the
 * other's row.
 */
export function repositoryChoices(
  connections: readonly RepositoryOptionView[],
  grant: readonly GrantedRepositoryView[],
): readonly RepositoryChoice[] {
  const rows = new Map<string, RepositoryChoice>();
  for (const repo of connections) {
    rows.set(repo.fullName, {
      fullName: repo.fullName,
      defaultBranch: repo.defaultBranch,
      cloneUrl: repo.cloneUrl,
      state: repo.alreadyDeploys ? 'deploys' : 'connected',
    });
  }
  for (const repo of grant) {
    if (rows.has(repo.fullName)) continue;
    rows.set(repo.fullName, {
      fullName: repo.fullName,
      defaultBranch: repo.defaultBranch,
      cloneUrl: repo.cloneUrl,
      state: 'grant-only',
    });
  }
  return [...rows.values()].sort((left, right) =>
    left.fullName.localeCompare(right.fullName),
  );
}

export function RepoPicker({
  repos,
  selected,
  onSelect,
}: {
  repos: readonly RepositoryChoice[];
  /** The fullName of the currently selected repo, or `null`. */
  selected: string | null;
  onSelect: (repo: RepositoryChoice) => void;
}) {
  const [filter, setFilter] = useState('');
  const normalised = filter.toLowerCase();

  const filtered = normalised
    ? repos.filter((repo) => repo.fullName.toLowerCase().includes(normalised))
    : repos;

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search
          aria-hidden="true"
          className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="text"
          placeholder="Filter repositories…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className={cn(
            'w-full rounded-md border border-border bg-card py-2 pl-9 pr-3 font-mono text-sm',
            'placeholder:text-muted-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
          )}
        />
      </div>

      <div className="flex max-h-[260px] flex-col gap-1 overflow-y-auto rounded-md border border-border bg-card p-1.5">
        {filtered.length === 0 ? (
          <p className="px-2 py-4 text-center text-sm text-muted-foreground">
            {filter
              ? 'No repositories match that filter.'
              : 'GitHub grants this installation no repositories. Authorize GitHub, or add repositories to the App installation, from Settings → Connections.'}
          </p>
        ) : (
          filtered.map((repo) => {
            const isSelected = selected === repo.fullName;
            const badge = STATE_BADGE[repo.state];
            return (
              <button
                key={repo.fullName}
                type="button"
                onClick={() => onSelect(repo)}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-3 py-2 text-left transition-colors',
                  isSelected
                    ? 'border border-primary bg-accent'
                    : 'border border-transparent hover:bg-secondary',
                )}
              >
                <GitBranch
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1 font-mono text-sm">
                  {repo.fullName}
                </span>
                <Badge tone="idle" className="shrink-0">
                  {repo.defaultBranch}
                </Badge>
                <Badge tone={badge.tone} className="shrink-0">
                  {badge.label}
                </Badge>
              </button>
            );
          })
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Selecting reads the repository and writes nothing. A repository GitHub
        grants gets its row and its configuration pull request when the App is
        created, and never before.
      </p>
    </div>
  );
}
