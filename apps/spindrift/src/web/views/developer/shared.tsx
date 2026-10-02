/**
 * What the CLI, SDK and MCP pages share: the one read they make, and the block
 * a command or a snippet is copied from.
 */
import type { ReactNode } from 'react';
import type { DeveloperSurfaces } from '../../../commands/developer/surfaces.ts';
import { useRead } from '../../poll.ts';
import { Eyebrow } from '../../ui/card.tsx';
import { CopyButton } from '../../ui/copy.tsx';
import { EmptyState } from '../../ui/empty-state.tsx';
import { DetailSkeleton, ScreenFailure } from '../screen.tsx';

export function Snippet({
  label,
  text,
}: {
  /** What is copied, for the control's accessible name. */
  readonly label: string;
  readonly text: string;
}) {
  return (
    <div className="relative min-w-0 rounded-sm border border-border bg-secondary/35">
      <pre className="overflow-x-auto px-3.5 py-3 pr-10 font-mono text-caption leading-6 text-foreground">
        {text}
      </pre>
      <CopyButton
        value={text}
        label={label}
        className="absolute right-2.5 top-2.5"
      />
    </div>
  );
}

export function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <Eyebrow>{title}</Eyebrow>
      {children}
    </section>
  );
}

export function Prose({ children }: { readonly children: ReactNode }) {
  return (
    <p className="max-w-3xl text-body leading-6 text-muted-foreground [&_code]:font-mono [&_code]:text-foreground">
      {children}
    </p>
  );
}

/** Said in place of any address, so no page falls back to a literal one. */
export function NoKthx({ what }: { readonly what: string }) {
  return (
    <EmptyState title="This installation names no kthx">{what}</EmptyState>
  );
}

/** Reads once: nothing on these pages changes while they are open. */
export function SurfacesScreen({
  title,
  children,
}: {
  /** Names the failure, as in "Failed to load the CLI page". */
  readonly title: string;
  readonly children: (surfaces: DeveloperSurfaces) => ReactNode;
}) {
  const read = useRead([['getDeveloperSurfaces', {}]] as const, null);
  if (read.type === 'loading') return <DetailSkeleton />;
  if (read.type === 'error') {
    return (
      <ScreenFailure
        title={`Failed to load the ${title} page`}
        message={read.failure.message}
        width="reading"
        onRetry={read.reload}
      />
    );
  }
  return children(read.value[0]);
}
