/**
 * The repository picker for the creation flow's Source step (§20, Task 24).
 *
 * Lists repositories currently granted to the GitHub App installation. A
 * developer selects one, and the selection populates the draft's source with
 * the repo's fullName and a composed clone URL. The picker does not create
 * connections — a missing repository sends the developer to GitHub's
 * installation settings (§20: installation is bootstrap, not user OAuth).
 *
 * The filter is a client-side substring match against fullName. It is fast
 * enough for the single-operator scale v1 targets, and the picker never
 * fetches — the list arrives as a prop from the same API call that populated
 * the creation flow.
 */
import { GitBranch, Search } from 'lucide-react';
import { useState } from 'react';
import type { RepositoryOptionView } from '../model.ts';
import { Badge } from '../ui/badge.tsx';
import { cn } from '../ui/utils.ts';

export function RepoPicker({
  repos,
  selected,
  onSelect,
}: {
  repos: readonly RepositoryOptionView[];
  /** The fullName of the currently selected repo, or `null`. */
  selected: string | null;
  onSelect: (fullName: string, url: string) => void;
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
              : 'No repositories available.'}
          </p>
        ) : (
          filtered.map((repo) => {
            const isSelected = selected === repo.fullName;
            return (
              <button
                key={repo.repositoryId}
                type="button"
                onClick={() =>
                  onSelect(
                    repo.fullName,
                    `https://github.com/${repo.fullName}.git`,
                  )
                }
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
                {repo.connected ? (
                  <Badge tone="success" className="shrink-0">
                    connected
                  </Badge>
                ) : null}
              </button>
            );
          })
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Missing a repository?{' '}
        <a
          href="https://github.com/settings/installations"
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-foreground underline underline-offset-2"
        >
          Add it to the GitHub App installation settings
        </a>
        , then refresh.
      </p>
    </div>
  );
}
