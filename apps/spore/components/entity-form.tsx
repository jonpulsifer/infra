'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

interface EntityFormFieldBase {
  name: string;
  label: string;
  helpText?: string;
}

export type EntityFormField =
  | (EntityFormFieldBase & {
      type: 'text';
      defaultValue?: string;
      placeholder?: string;
      required?: boolean;
      disabled?: boolean;
      pattern?: string;
      className?: string;
    })
  | (EntityFormFieldBase & {
      type: 'textarea';
      defaultValue?: string;
      required?: boolean;
      className?: string;
    })
  | (EntityFormFieldBase & {
      type: 'select';
      defaultValue?: string;
      options: { value: string; label: string }[];
    })
  | (EntityFormFieldBase & {
      type: 'switch';
      description?: string;
      defaultChecked?: boolean;
    });

export interface EntityFormSection {
  title?: string;
  description?: string;
  fields: EntityFormField[];
  /** Wrap this section's fields in a Card. Defaults to true. */
  card?: boolean;
}

export interface EntityFormProps {
  sections: EntityFormSection[];
  /** Called with the submitted FormData. Throw to surface an error message. */
  onSubmit: (formData: FormData) => Promise<void>;
  /** Called after a successful submit, e.g. router.refresh() or a redirect. */
  onSubmitted?: (formData: FormData) => void;
  submitLabel?: string;
  submittingLabel?: string;
  /** Omit to hide the delete button entirely. */
  onDelete?: () => Promise<void>;
  deleteConfirmMessage?: string;
  deleteLabel?: string;
  deletingLabel?: string;
  /** Omit to hide the Cancel link. */
  cancelHref?: string;
  className?: string;
}

function FieldInput({ field }: { field: EntityFormField }) {
  switch (field.type) {
    case 'text':
      return (
        <Input
          id={field.name}
          name={field.name}
          defaultValue={field.defaultValue}
          placeholder={field.placeholder}
          required={field.required}
          disabled={field.disabled}
          pattern={field.pattern}
          className={field.className}
        />
      );
    case 'textarea':
      return (
        <Textarea
          id={field.name}
          name={field.name}
          defaultValue={field.defaultValue}
          required={field.required}
          className={field.className ?? 'min-h-[400px] font-mono text-sm'}
        />
      );
    case 'select':
      return (
        <Select name={field.name} defaultValue={field.defaultValue}>
          <SelectTrigger>
            <SelectValue placeholder={field.label} />
          </SelectTrigger>
          <SelectContent>
            {field.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case 'switch':
      return (
        <Switch
          id={field.name}
          name={field.name}
          defaultChecked={field.defaultChecked}
        />
      );
  }
}

function FormField({ field }: { field: EntityFormField }) {
  if (field.type === 'switch') {
    return (
      <div className="flex items-center justify-between rounded-lg border p-4">
        <div>
          <Label htmlFor={field.name}>{field.label}</Label>
          {field.description && (
            <p className="text-sm text-muted-foreground">{field.description}</p>
          )}
        </div>
        <FieldInput field={field} />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={field.name}>{field.label}</Label>
      <FieldInput field={field} />
      {field.helpText && (
        <p className="text-xs text-muted-foreground">{field.helpText}</p>
      )}
    </div>
  );
}

/**
 * Generic entity edit form: renders field sections from a small declarative
 * schema and owns the submit/delete state machine (loading flags,
 * confirm-before-delete, error display) that was previously duplicated
 * across the host/profile/script edit forms.
 */
export function EntityForm({
  sections,
  onSubmit,
  onSubmitted,
  submitLabel = 'Save Changes',
  submittingLabel = 'Saving...',
  onDelete,
  deleteConfirmMessage = 'Delete this item? This cannot be undone.',
  deleteLabel = 'Delete',
  deletingLabel = 'Deleting...',
  cancelHref,
  className,
}: EntityFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    const formData = new FormData(e.currentTarget);
    try {
      await onSubmit(formData);
      onSubmitted?.(formData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save changes');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!onDelete) return;
    if (!confirm(deleteConfirmMessage)) return;

    setIsDeleting(true);
    try {
      await onDelete();
    } finally {
      setIsDeleting(false);
    }
  }

  const actions = (
    <div className="flex justify-between">
      {onDelete ? (
        <Button
          type="button"
          variant="destructive"
          onClick={handleDelete}
          disabled={isDeleting}
        >
          {isDeleting ? deletingLabel : deleteLabel}
        </Button>
      ) : (
        <span />
      )}
      <div className="flex gap-4">
        {cancelHref && (
          <Link href={cancelHref}>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </Link>
        )}
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? submittingLabel : submitLabel}
        </Button>
      </div>
    </div>
  );

  return (
    <form onSubmit={handleSubmit} className={className ?? 'space-y-6'}>
      {sections.map((section, index) => {
        const isLast = index === sections.length - 1;
        const body = (
          <>
            <div className="space-y-4">
              {section.fields.map((field) => (
                <FormField key={field.name} field={field} />
              ))}
            </div>
            {isLast && error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
            {isLast && actions}
          </>
        );

        if (section.card === false) {
          return (
            <div key={section.title ?? index} className="space-y-4">
              {body}
            </div>
          );
        }

        return (
          <Card key={section.title ?? index}>
            {(section.title || section.description) && (
              <CardHeader>
                {section.title && <CardTitle>{section.title}</CardTitle>}
                {section.description && (
                  <CardDescription>{section.description}</CardDescription>
                )}
              </CardHeader>
            )}
            <CardContent className="space-y-4">{body}</CardContent>
          </Card>
        );
      })}
    </form>
  );
}
