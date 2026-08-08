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
import { CircleAlert, Lock, Plus, Trash2 } from 'lucide-react';
import { Badge } from '../ui/badge.tsx';
import { Button } from '../ui/button.tsx';
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
   * Whether one path is somebody else's to write — read-only rather than
   * saving-right-now, which is what `disabled` says.
   *
   * A predicate over paths rather than a flag on a field, because the answer is
   * a fact about the *document* and this file has none: which value a screen
   * may not drive depends on what the document says elsewhere, and a field
   * carrying it would be the schema describing a screen. The caller answers for
   * a path and everything under it; omitted means nothing is locked.
   */
  locked?(at: Path): boolean;
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

/**
 * Whether a control at this path may not be written — either reason.
 *
 * The two are one word to a control and two words to a reader: `disabled` is
 * "not right now, a save is in flight" and `locked` is "not here, ever". The
 * sentence explaining the second belongs on the screen that knows it, not on
 * every input.
 */
function isFrozen(form: FormProps, at: Path): boolean {
  return form.disabled || form.locked?.(at) === true;
}

/**
 * The second of those two words, said where the reader is.
 *
 * The comment above admitted the collapse and the reader still only got one
 * word: a value the mounted declaration owns rendered exactly like a value a
 * save was in flight over — greyed out, unexplained, and indistinguishable from
 * a form that had broken. A governed field is the *most* authoritative value on
 * the screen, so it is marked as declared and keeps its full contrast, and only
 * the save-in-flight arm keeps the dimming that means "wait".
 *
 * Still `disabled`, not `readOnly`: the value cannot be changed here by any
 * route, and `readOnly` would leave it in the submitted form as something this
 * screen appeared to be sending.
 */
function isDeclared(form: FormProps, at: Path): boolean {
  return form.locked?.(at) === true;
}

/**
 * Whether this is the *outermost* declared thing, and so the one to mark.
 *
 * The predicate answers for a path and everything under it, so a governed
 * vessel makes its name, its kind, its location and every shared service answer
 * yes — and badging all of them would put eight identical markers inside one
 * card to say one thing. The boundary is where the answer changes.
 */
function marksDeclared(form: FormProps, at: Path): boolean {
  return isDeclared(form, at) && !isDeclared(form, at.slice(0, -1));
}

/** The class that undoes {@link Input}'s dimming, for the declared arm only. */
const UNDIMMED = 'disabled:opacity-100';

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
  const frozen = isFrozen(form, at);

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
      <div className="flex items-center gap-2">
        {togglable ? (
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
        ) : null}
        <Label htmlFor={id}>{field.label}</Label>
        {marksDeclared(form, at) ? (
          <Badge tone="idle">
            <Lock aria-hidden="true" className="size-3" />
            declared
          </Badge>
        ) : null}
      </div>
      {field.description ? (
        <p className="text-xs text-muted-foreground">{field.description}</p>
      ) : null}
      {present ? (
        <SchemaControl node={field.node} at={at} form={form} />
      ) : (
        <p className="font-mono text-xs text-muted-foreground">
          {field.nullable && value === null ? 'null' : 'not configured'}
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
  const frozen = isFrozen(form, at);
  // Dimmed only while a save is in flight. A declared value is not pending, it
  // is settled, and greying it said the opposite.
  const undimmed = isDeclared(form, at) ? UNDIMMED : undefined;
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
          className={undimmed}
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
          className={undimmed}
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
          className={cn('size-4 accent-accent', undimmed)}
        />
      );
    case 'enum':
      return (
        <Select
          id={id}
          value={typeof value === 'string' ? value : ''}
          disabled={frozen}
          className={undimmed}
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

function ArrayControl({
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
    <div className="flex flex-col gap-3">
      {items.map((_, index) => (
        <div
          // The index is the identity: these rows have no id of their own, and
          // the order is meaningful — §16 makes array order the admin rank.
          key={`${pathKey(at)}.${index}`}
          className="flex items-start gap-2 rounded-md border border-border/70 p-3"
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
            // Per item, not per array: an array may hold one entry somebody else
            // declares and others a screen owns outright, and locking the whole
            // control for the first would take the second away too.
            disabled={isFrozen(form, [...at, index])}
            aria-label={`Remove item ${index + 1}`}
            onClick={() =>
              form.onChange(withoutValueAt(form.document, [...at, index]))
            }
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="self-start"
        disabled={form.disabled}
        onClick={() =>
          form.onChange(
            withValueAt(form.document, at, [
              ...items,
              blankValue(node.element),
            ]),
          )
        }
      >
        <Plus aria-hidden="true" />
        Add
      </Button>
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
            disabled={isFrozen(form, at)}
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
