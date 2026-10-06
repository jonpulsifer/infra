/**
 * The installation manifest as a form. It reads the schema the configure
 * command validates against, so it cannot offer a field the server refuses.
 */
import { installationManifestSchema } from '../../config/manifest.schema.ts';
import type { Path } from './document.ts';
import type { FieldErrors } from './render.tsx';
import { describeObject, type FormField, type FormNode } from './schema.ts';

const FIELDS: readonly FormField[] = describeObject(installationManifestSchema);

export function manifestFields(): readonly FormField[] {
  return FIELDS;
}

/** `null` for a path this build's schema does not have. */
export function manifestFieldAt(at: Path): FormField | null {
  return fieldAt({ kind: 'object', fields: FIELDS }, at);
}

/**
 * A path ending on an array index is `null`: an element is not a field. Each
 * union arm is tried with the remaining path, since arms can share a key.
 */
function fieldAt(node: FormNode, path: Path): FormField | null {
  const [step, ...rest] = path;
  if (step === undefined) return null;
  if (node.kind === 'union') {
    for (const variant of node.variants) {
      const found = fieldAt(variant.node, path);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof step === 'number') {
    return node.kind === 'array' ? fieldAt(node.element, rest) : null;
  }
  if (node.kind !== 'object') return null;
  const field = node.fields.find((each) => each.key === step);
  if (field === undefined) return null;
  return rest.length === 0 ? field : fieldAt(field.node, rest);
}

/**
 * Issues keyed by the dotted path of the offending value. An issue against the
 * document itself is keyed `(root)`, as `validateManifest` spells it.
 */
export function manifestIssues(document: unknown): FieldErrors {
  const result = installationManifestSchema.safeParse(document);
  if (result.success) return new Map();

  const errors = new Map<string, string[]>();
  for (const issue of result.error.issues) {
    const path = issue.path.map(String).join('.') || '(root)';
    const existing = errors.get(path);
    if (existing === undefined) {
      errors.set(path, [issue.message]);
    } else {
      existing.push(issue.message);
    }
  }
  return errors;
}
