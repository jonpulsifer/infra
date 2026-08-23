/**
 * Rendering a {@link FormNode} tree as controls.
 *
 * The whole of this file is a fold over the shape `schema.ts` derived. It knows
 * about strings, enums, objects, arrays and unions; it knows nothing about
 * manifests, installations, registries or Targets. That is the point — the
 * screen that does know is one component, and everything a field needs in order
 * to be edited comes from the schema rather than from a list somebody maintains.
 *
 * Errors arrive keyed by path and are rendered against the control at that
 * path, so the sentence a Zod issue carries is shown where the value that
 * caused it is typed rather than collected into a summary at the bottom.
 */
import { ChevronRight, CircleAlert, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '../ui/badge.tsx';
import { Button } from '../ui/button.tsx';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../ui/collapsible.tsx';
import { Input, Label } from '../ui/field.tsx';
import { cn } from '../ui/utils.ts';
import {
  blankValue,
  type Path,
  pathKey,
  switchVariant,
  valueAt,
  variantOf,
  withoutValueAt,
  withValueAt,
} from './document.ts';
import type { FormField, FormNode } from './schema.ts';

/** One thing wrong with one path, as `configureInstallation` reports it. */
export type FieldErrors = ReadonlyMap<string, readonly string[]>;

export interface FormProps {
  /** The whole document being edited; every control reads its own path from it. */
  readonly document: unknown;
  readonly errors: FieldErrors;
  readonly disabled: boolean;
  /**
   * Whether the controls this form renders should take focus on mount.
   *
   * For the screen that mounts **one question at a time**, and it is a flag
   * rather than a path because that screen already decided which key it is
   * asking: onboarding renders a single field and the whole point is that
   * typing the answer is the first thing that happens. A form rendering the
   * whole manifest leaves it unset — a settings page that grabbed the cursor
   * into whichever key the schema happens to declare first would be a page
   * fighting the reader.
   *
   * The text and number controls honour it and the `<select>` does not, which
   * is not a principle: no step asks for an enum, and the day one does is the
   * day to decide whether opening a dropdown under the reader is a kindness.
   */
  readonly autoFocus?: boolean;
  onChange(document: unknown): void;
}

/** Every key of an object schema, in the order the schema declares them. */
export function SchemaFields({
  fields,
  at,
  form,
}: {
  readonly fields: readonly FormField[];
  readonly at: Path;
  readonly form: FormProps;
}) {
  return (
    <div className="flex flex-col gap-4">
      {fields.map((field) => (
        <SchemaFieldControl
          key={field.key}
          field={field}
          at={[...at, field.key]}
          form={form}
        />
      ))}
    </div>
  );
}

/**
 * One key, with whatever its optionality permits.
 *
 * A key that may be absent or `null` gets a checkbox before its control,
 * because "this installation has no Gateway" is a configuration an operator
 * chooses and an empty text box is not a way to say it.
 */
function SchemaFieldControl({
  field,
  at,
  form,
}: {
  readonly field: FormField;
  readonly at: Path;
  readonly form: FormProps;
}) {
  const value = valueAt(form.document, at);
  const present = value !== undefined && value !== null;
  const togglable = field.optional || field.nullable;
  const id = pathKey(at);
  const frozen = form.disabled === true;

  const toggle = (on: boolean) => {
    if (on) {
      form.onChange(withValueAt(form.document, at, blankValue(field.node)));
    } else if (field.nullable) {
      form.onChange(withValueAt(form.document, at, null));
    } else {
      form.onChange(withoutValueAt(form.document, at));
    }
  };

  const nested = field.node.kind === 'object' || field.node.kind === 'array';

  return (
    <div
      className={cn(
        'flex flex-col gap-1.5',
        nested && 'rounded-md border border-border/70 p-3',
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id}>{field.label}</Label>
        {/* The key's own switch, on the right and carrying a word.
            A bare checkbox jammed against the label read as part of the value
            — a boolean field with no name — rather than as the question it is,
            which is whether this installation states this key at all. */}
        {togglable ? (
          <label
            htmlFor={`${id}--present`}
            className="flex shrink-0 cursor-pointer items-center gap-1.5 text-micro text-muted-foreground"
          >
            <input
              type="checkbox"
              id={`${id}--present`}
              name={`${id}--present`}
              checked={present}
              disabled={frozen}
              onChange={(event) => toggle(event.currentTarget.checked)}
              className="size-3.5 accent-accent"
              aria-label={`Configure ${field.label}`}
            />
            configure
          </label>
        ) : null}
      </div>
      {field.description ? (
        <p className="text-xs text-muted-foreground">{field.description}</p>
      ) : null}
      {present ? (
        <SchemaControl node={field.node} at={at} form={form} />
      ) : (
        // A sentence rather than the raw absence. `null` in monospace is what
        // the document holds, not what an operator asked; the two states are
        // different answers and read as different sentences.
        <p className="text-xs text-muted-foreground">
          {field.nullable && value === null
            ? 'Stated as none. This installation has no such thing.'
            : 'Not configured. This installation says nothing here.'}
        </p>
      )}
      <IssueList at={at} errors={form.errors} />
    </div>
  );
}

/** The control a node's kind calls for. */
export function SchemaControl({
  node,
  at,
  form,
}: {
  readonly node: FormNode;
  readonly at: Path;
  readonly form: FormProps;
}) {
  const value = valueAt(form.document, at);
  const id = pathKey(at);
  const frozen = form.disabled === true;
  // Dimmed only while a save is in flight. A declared value is not pending, it
  // is settled, and greying it said the opposite.
  const set = (next: unknown) =>
    form.onChange(withValueAt(form.document, at, next));

  switch (node.kind) {
    case 'string':
      return (
        <Input
          id={id}
          name={id}
          type={node.format === 'url' ? 'url' : 'text'}
          value={typeof value === 'string' ? value : ''}
          disabled={frozen}
          autoFocus={form.autoFocus}
          onChange={(event) => set(event.currentTarget.value)}
        />
      );
    case 'number':
      return (
        <Input
          id={id}
          name={id}
          type="number"
          step={node.integer ? 1 : 'any'}
          value={typeof value === 'number' ? String(value) : ''}
          disabled={frozen}
          autoFocus={form.autoFocus}
          onChange={(event) => {
            const parsed = Number(event.currentTarget.value);
            set(event.currentTarget.value === '' ? undefined : parsed);
          }}
        />
      );
    case 'boolean':
      return (
        <input
          type="checkbox"
          id={id}
          name={id}
          checked={value === true}
          disabled={frozen}
          onChange={(event) => set(event.currentTarget.checked)}
          className="size-4 accent-accent"
        />
      );
    case 'enum':
      return (
        <Select
          id={id}
          value={typeof value === 'string' ? value : ''}
          disabled={frozen}
          onChange={set}
          options={node.values.map((each) => ({ value: each, label: each }))}
        />
      );
    case 'literal':
      // Not editable, and shown rather than hidden: it is the answer to "which
      // kind of thing is this", and the union's own selector is what changes it.
      return (
        <p className="font-mono text-sm text-muted-foreground">{node.value}</p>
      );
    case 'object':
      return <SchemaFields fields={node.fields} at={at} form={form} />;
    case 'array':
      return <ArrayControl node={node} at={at} form={form} />;
    case 'union':
      return <UnionControl node={node} at={at} form={form} />;
    case 'unsupported':
      return (
        <p className="flex items-center gap-1.5 text-xs text-terminal-destructive">
          <CircleAlert aria-hidden="true" className="size-3.5" />
          This build of the form cannot edit a {node.type} field. Its current
          value is submitted unchanged.
        </p>
      );
  }
}

/**
 * What an array entry is, in a line, without knowing what kind of thing it is.
 *
 * An array of five boundaries rendered as five identical bordered boxes with
 * every field open at once, and the only way to tell which was which was to
 * read the first input inside it. The document has the answer — a vessel has a
 * name, a Target names the vessel it sits on, a build route has a name — but
 * nothing here may go looking for those keys: this file renders whatever the
 * schema declares and names none of it, which is what keeps it correct as keys
 * arrive and leave.
 *
 * So it is derived by **shape**, not by key. The title is the first string
 * field that has a value, which is what an identity looks like in every array
 * this schema has; the tag is the first enum or literal, which is what a kind
 * looks like. An entry that has neither is `#n`, which is what it was before.
 *
 * Pure and exported because it is the whole of the claim worth asserting
 * without a browser: the same document that renders a box gets a name on it.
 */
export function summarize(
  node: FormNode,
  value: unknown,
): { readonly title?: string; readonly tag?: string } {
  // A union's active variant is the object actually on screen, so the summary
  // comes from that rather than from the wrapper.
  if (node.kind === 'union') {
    const active = variantOf(node.variants, node.discriminator, value);
    return active === undefined ? {} : summarize(active.node, value);
  }
  if (node.kind !== 'object' || value === null || typeof value !== 'object') {
    return {};
  }
  const held = value as Record<string, unknown>;
  let title: string | undefined;
  let tag: string | undefined;
  for (const field of node.fields) {
    const at = held[field.key];
    if (
      title === undefined &&
      field.node.kind === 'string' &&
      typeof at === 'string' &&
      at !== ''
    ) {
      title = at;
    }
    if (tag === undefined) {
      if (field.node.kind === 'literal') tag = field.node.value;
      else if (
        field.node.kind === 'enum' &&
        typeof at === 'string' &&
        at !== ''
      )
        tag = at;
    }
  }
  return { title, tag };
}

/** Whether anything under this path is refused, so its box must not be shut. */
function refusedUnder(errors: FieldErrors, at: Path): boolean {
  const here = pathKey(at);
  for (const path of errors.keys()) {
    if (path === here || path.startsWith(`${here}.`)) return true;
  }
  return false;
}

/**
 * A list of values is not a list of records, and it must not be drawn as one.
 *
 * `reaches` is two words out of three. Rendering it the way a list of vessels
 * is rendered gave it two bordered, collapsible boxes titled `#1` and `#2`,
 * each holding a dropdown — three interactions and a scroll to say a thing the
 * schema already knows is a choice from a fixed set. Same for a list of bucket
 * names: a box called `#1` around a text field is a box saying nothing.
 *
 * So the element's kind picks the control, which is the same rule the rest of
 * this file follows one level down. An enum element is the whole set, toggled;
 * anything else scalar is a row per value; only an object or a union — the
 * kinds that have an identity worth summarizing — gets the card.
 */
function ArrayControl({
  node,
  at,
  form,
}: {
  readonly node: FormNode & { kind: 'array' };
  readonly at: Path;
  readonly form: FormProps;
}) {
  if (node.element.kind === 'enum') {
    return <EnumSetControl values={node.element.values} at={at} form={form} />;
  }
  if (node.element.kind !== 'object' && node.element.kind !== 'union') {
    return <ScalarListControl node={node} at={at} form={form} />;
  }
  return <RecordListControl node={node} at={at} form={form} />;
}

/**
 * Every value the schema allows, on or off.
 *
 * No add, no remove, no order: the set is closed and stated by the schema, so
 * the only question is which of them hold — and an operator who can see all
 * three at once never has to learn what the third one was called.
 *
 * Written back in the schema's own order rather than the order they were
 * pressed. Nothing reads these as a ranking (§16's rank is the order of
 * `targets`, which is a list of records and keeps its order), and a set that
 * reshuffles itself as it is edited is a diff nobody can read.
 */
function EnumSetControl({
  values,
  at,
  form,
}: {
  readonly values: readonly string[];
  readonly at: Path;
  readonly form: FormProps;
}) {
  const value = valueAt(form.document, at);
  const held = Array.isArray(value) ? value.map(String) : [];
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((each) => {
        const on = held.includes(each);
        return (
          <button
            key={each}
            type="button"
            aria-pressed={on}
            name={`${pathKey(at)}--${each}`}
            disabled={form.disabled}
            onClick={() =>
              form.onChange(
                withValueAt(
                  form.document,
                  at,
                  values.filter((candidate) =>
                    candidate === each ? !on : held.includes(candidate),
                  ),
                ),
              )
            }
            className={cn(
              'rounded-full border px-2.5 py-0.5 font-mono text-micro transition-colors',
              'disabled:cursor-not-allowed disabled:opacity-60',
              on
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border text-muted-foreground hover:border-primary hover:text-foreground',
            )}
          >
            {each}
          </button>
        );
      })}
    </div>
  );
}

/** One row per value: the control, and the button that drops it. */
function ScalarListControl({
  node,
  at,
  form,
}: {
  readonly node: FormNode & { kind: 'array' };
  readonly at: Path;
  readonly form: FormProps;
}) {
  const value = valueAt(form.document, at);
  const items = Array.isArray(value) ? value : [];
  return (
    <div className="flex flex-col gap-1.5">
      {items.map((_, index) => (
        <div
          // The index is the identity: these rows have no id of their own, and
          // the order is meaningful — §16 makes array order the admin rank.
          key={`${pathKey(at)}.${index}`}
          className="flex items-center gap-1.5"
        >
          <div className="min-w-0 flex-1">
            <SchemaControl
              node={node.element}
              at={[...at, index]}
              form={form}
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={form.disabled}
            aria-label={`Remove item ${index + 1}`}
            onClick={() =>
              form.onChange(withoutValueAt(form.document, [...at, index]))
            }
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      ))}
      <AddEntry node={node} at={at} form={form} items={items} />
    </div>
  );
}

/** The button every list grows by, so the three arms say it once. */
function AddEntry({
  node,
  at,
  form,
  items,
  onAdded,
}: {
  readonly node: FormNode & { kind: 'array' };
  readonly at: Path;
  readonly form: FormProps;
  readonly items: readonly unknown[];
  onAdded?(index: number): void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="self-start"
      disabled={form.disabled}
      onClick={() => {
        onAdded?.(items.length);
        form.onChange(
          withValueAt(form.document, at, [...items, blankValue(node.element)]),
        );
      }}
    >
      <Plus aria-hidden="true" />
      Add
    </Button>
  );
}

function RecordListControl({
  node,
  at,
  form,
}: {
  readonly node: FormNode & { kind: 'array' };
  readonly at: Path;
  readonly form: FormProps;
}) {
  const value = valueAt(form.document, at);
  const items = Array.isArray(value) ? value : [];
  /**
   * Which entries the reader has opened.
   *
   * Closed is the default because the point of the summary above is that the
   * list is legible without opening anything — twelve cards of arrays with
   * every field expanded is the shape that made this page read as a JSON
   * editor. Two things open a box anyway, and neither is a preference: an
   * entry that was just added has nothing in it to summarize, and an entry a
   * save came back refusing must not hide the control that caused it.
   *
   * Keyed by index, which the row already treats as the identity — these
   * entries have no id of their own and the order is meaningful, since §16
   * makes array order the admin rank.
   */
  const [opened, setOpened] = useState<readonly number[]>([]);

  return (
    <div className="flex flex-col gap-2">
      {items.map((item, index) => {
        const entry: Path = [...at, index];
        const { title, tag } = summarize(node.element, item);
        const open = opened.includes(index) || refusedUnder(form.errors, entry);
        return (
          <Collapsible
            key={`${pathKey(at)}.${index}`}
            open={open}
            onOpenChange={(next) =>
              setOpened((current) =>
                next
                  ? [...current, index]
                  : current.filter((each) => each !== index),
              )
            }
            className="rounded-md border border-border/70"
          >
            <div className="flex items-center gap-2 px-3 py-2">
              <CollapsibleTrigger
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left',
                  'focus-visible:-outline-offset-2',
                )}
              >
                <ChevronRight
                  aria-hidden="true"
                  className={cn(
                    'size-3.5 shrink-0 text-subtle transition-transform',
                    open && 'rotate-90',
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-body font-medium">
                  {title ?? `#${index + 1}`}
                </span>
                {tag === undefined ? null : <Badge tone="idle">{tag}</Badge>}
                {refusedUnder(form.errors, entry) ? (
                  <Badge tone="destructive">refused</Badge>
                ) : null}
              </CollapsibleTrigger>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                // Per item, not per array: an array may hold one entry somebody
                // else declares and others a screen owns outright, and locking
                // the whole control for the first would take the second away too.
                disabled={form.disabled}
                aria-label={`Remove ${title ?? `item ${index + 1}`}`}
                onClick={() =>
                  form.onChange(withoutValueAt(form.document, entry))
                }
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
            {/* Mounted whether or not it is open, and hidden with CSS.
                Radix unmounts closed content by default, which would take
                every field in a shut entry out of the document — out of
                find-in-page, out of a static render, and out of anything that
                walks the form. A box being shut is a display decision and must
                not become a data decision, the same rule `ui/copy.tsx` states
                about truncation. */}
            <CollapsibleContent
              forceMount
              className="border-t border-border/70 p-3 data-[state=closed]:hidden"
            >
              <SchemaControl node={node.element} at={entry} form={form} />
            </CollapsibleContent>
          </Collapsible>
        );
      })}
      {/* Open the one just added: a new entry has nothing to summarize, so a
          closed box would be a row reading `#6` and no way to see why. */}
      <AddEntry
        node={node}
        at={at}
        form={form}
        items={items}
        onAdded={(index) => setOpened((current) => [...current, index])}
      />
    </div>
  );
}

function UnionControl({
  node,
  at,
  form,
}: {
  readonly node: FormNode & { kind: 'union' };
  readonly at: Path;
  readonly form: FormProps;
}) {
  const value = valueAt(form.document, at);
  const active = variantOf(node.variants, node.discriminator, value);
  const id = pathKey(at);

  return (
    <div className="flex flex-col gap-3">
      {node.discriminator === null ? null : (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}--variant`}>
            {node.discriminator.charAt(0).toUpperCase()}
            {node.discriminator.slice(1)}
          </Label>
          <Select
            id={`${id}--variant`}
            value={active?.tag ?? ''}
            disabled={form.disabled}
            onChange={(next) => {
              const chosen = node.variants.find((each) => each.tag === next);
              if (chosen === undefined) return;
              form.onChange(
                withValueAt(form.document, at, switchVariant(value, chosen)),
              );
            }}
            options={node.variants.map((variant) => ({
              value: variant.tag ?? '',
              label: variant.label,
            }))}
          />
        </div>
      )}
      {active === undefined || active.node.kind !== 'object' ? null : (
        <SchemaFields
          // The discriminator is chosen above; repeating it as a read-only
          // literal below would be the same fact twice.
          fields={active.node.fields.filter(
            (field) => field.key !== node.discriminator,
          )}
          at={at}
          form={form}
        />
      )}
    </div>
  );
}

/** A `<select>` styled like {@link Input}, so the two do not diverge. */
function Select({
  id,
  value,
  options,
  disabled,
  className,
  onChange,
}: {
  readonly id: string;
  readonly value: string;
  readonly options: readonly { value: string; label: string }[];
  readonly disabled: boolean;
  readonly className?: string;
  onChange(value: string): void;
}) {
  return (
    <select
      id={id}
      name={id}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.value)}
      className={cn(
        'h-9 w-full rounded-md border border-input bg-background px-3',
        'font-mono text-sm text-foreground',
        'disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** Whatever the server or the schema said about this exact path. */
function IssueList({
  at,
  errors,
}: {
  readonly at: Path;
  readonly errors: FieldErrors;
}) {
  const issues = errors.get(pathKey(at));
  if (issues === undefined || issues.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5">
      {issues.map((issue) => (
        <li key={issue} className="text-xs text-terminal-destructive">
          {issue}
        </li>
      ))}
    </ul>
  );
}
