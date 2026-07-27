/**
 * The dense checklist — one line per resource or build step, and no tree.
 *
 * §18 settled this against a chip grid: "a dense list reads as one rollout with
 * parts, which is what it is. **Per-resource detail is one line, no tree.**"
 * The grid lost because it made four resources look like four things happening
 * rather than one thing arriving, and a tree lost because the nesting a
 * Kubernetes rollout actually has is the platform's business, not the
 * developer's.
 *
 * One component serves both build steps and deployed resources on purpose.
 * They are the same shape — a name, a state, and one line of platform words —
 * and giving them two components is how they drift apart.
 */
import type { ChecklistItem } from '../model.ts';
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
