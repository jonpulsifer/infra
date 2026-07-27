/**
 * `cn` — the class merger every component in `ui/` composes through.
 *
 * Two jobs in one call, and they are different jobs. `clsx` flattens the
 * conditional forms a component wants to write (`{ hidden: !open }`, a nested
 * array, a `false` that should vanish). `tailwind-merge` then resolves the
 * conflicts that flattening exposes: a variant that sets `px-3` and a caller
 * that passes `px-6` both survive `clsx`, and only the last one should reach
 * the DOM.
 *
 * The consequence worth naming is that **a caller's `className` always wins**,
 * because it is merged last. That is what makes every component here
 * overridable at its call site without growing a prop for each thing somebody
 * might want to move.
 */
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
