/**
 * One line per build step or deployed resource, with no tree, so a rollout
 * reads as one thing arriving. Steps and resources share it to stay alike.
 */
import type { ChecklistItem } from '../../commands/views.ts';
import { cn } from '../ui/utils.ts';
import { StepGlyph } from './status.tsx';

export function Checklist({ items }: { items: readonly ChecklistItem[] }) {
  return (
    <ul className="flex flex-col">
      {items.map((item) => (
        <li
          key={item.name}
          className={cn(
            'flex items-center gap-2.5 border-b border-border-soft py-1.5 last:border-b-0',
            'font-mono text-[12.5px]',
            item.status === 'waiting' && 'opacity-55',
          )}
        >
          <StepGlyph status={item.status} />
          <span
            className={cn(
              'min-w-0 flex-1 truncate',
              item.status === 'waiting' ? 'text-subtle' : 'text-foreground',
            )}
          >
            {item.name}
          </span>
          {item.detail ? (
            <span className="shrink-0 text-[11.5px] text-muted-foreground">
              {item.detail}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
