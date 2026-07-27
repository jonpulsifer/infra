/**
 * Collapsible — Radix's, re-exported under this app's names.
 *
 * A `<details>` element would render the same thing and was what the prototype
 * used. It is not enough here for one reason: §18 requires the build log to
 * **auto-open on red or running**, which means open-ness is derived from deploy
 * state that arrives after first paint, and `<details open>` is an uncontrolled
 * attribute React will not take back once the reader has touched it. Radix's
 * controlled `open`/`onOpenChange` pair is the whole reason for the dependency.
 */
export {
  Content as CollapsibleContent,
  Root as Collapsible,
  Trigger as CollapsibleTrigger,
} from '@radix-ui/react-collapsible';
