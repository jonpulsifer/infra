/**
 * Renders a {@link FormNode} tree as controls. It names no manifest key, and
 * each error shows beside the control at the path it is keyed by.
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

/** Messages keyed by {@link pathKey}. */
export type FieldErrors = ReadonlyMap<string, readonly string[]>;

export interface FormProps {
  readonly document: unknown;
  readonly errors: FieldErrors;
  readonly disabled: boolean;
  /** Text and number inputs honour it; selects do not. */
  readonly autoFocus?: boolean;
  onChange(document: unknown): void;
}

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
 * Optional and nullable keys get a switch, since an empty input cannot say
 * that a key is absent.
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
        <p className="flex items-center gap-1.5 text-xs text-destructive">
          <CircleAlert aria-hidden="true" className="size-3.5" />
          This build of the form cannot edit a {node.type} field. Its current
          value is submitted unchanged.
        </p>
      );
  }
}

/**
 * An array entry's header, found by shape: the first non-empty string field is
 * the title, and the first enum or literal is the tag.
 */
export function summarize(
  node: FormNode,
  value: unknown,
): { readonly title?: string; readonly tag?: string } {
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

function refusedUnder(errors: FieldErrors, at: Path): boolean {
  const here = pathKey(at);
  for (const path of errors.keys()) {
    if (path === here || path.startsWith(`${here}.`)) return true;
  }
  return false;
}

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

/** Written back in schema order, so a toggle never reorders the list. */
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
          // Rows have no id of their own and order is meaningful (targets order
          // is the admin rank), so the index is the identity.
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
  // Entries start closed. A new entry opens, having nothing to summarize, and
  // an entry with an error under it cannot close. Keyed by index: order is
  // meaningful, so entries are never re-sorted.
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
                disabled={form.disabled}
                aria-label={`Remove ${title ?? `item ${index + 1}`}`}
                onClick={() =>
                  form.onChange(withoutValueAt(form.document, entry))
                }
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
            {/* Radix unmounts closed content, which would take a shut entry's
                fields out of find-in-page and static renders. */}
            <CollapsibleContent
              forceMount
              className="border-t border-border/70 p-3 data-[state=closed]:hidden"
            >
              <SchemaControl node={node.element} at={entry} form={form} />
            </CollapsibleContent>
          </Collapsible>
        );
      })}
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
          // The selector above already shows the discriminator.
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
        <li key={issue} className="text-xs text-destructive">
          {issue}
        </li>
      ))}
    </ul>
  );
}
