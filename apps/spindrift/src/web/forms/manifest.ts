/**
 * The installation manifest, as a form.
 *
 * One module, two functions, and the reason both exist is that they must read
 * the **same schema the command validates against**. `configureInstallation`
 * re-exports `installationManifestSchema` for exactly this: a screen that
 * described the document from a copy could offer a field the server refuses, or
 * refuse one the server takes, and neither would show up until an operator hit
 * it.
 *
 * Nothing here lists a key. Both functions are the schema applied to something.
 */
import { installationManifestSchema } from '../../config/manifest.schema.ts';
import type { FieldErrors } from './render.tsx';
import { describeObject, type FormField } from './schema.ts';

/**
 * The manifest's top-level keys, as fields, in the order the schema declares
 * them.
 *
 * Computed once: the schema does not change while the process runs, and a
 * re-derivation per render would make every keystroke walk the document type.
 */
const FIELDS: readonly FormField[] = describeObject(installationManifestSchema);

export function manifestFields(): readonly FormField[] {
  return FIELDS;
}

/**
 * What is wrong with a document, keyed by the path of the value that is wrong.
 *
 * Empty when the document is valid. The keying is what lets a Zod issue be
 * rendered against the control that produced it rather than in a list at the
 * bottom of the screen — `dns.zones.private` names one input, and `targets.1.name`
 * names one row of one array.
 */
export function manifestIssues(document: unknown): FieldErrors {
  const result = installationManifestSchema.safeParse(document);
  if (result.success) return new Map();

  const errors = new Map<string, string[]>();
  for (const issue of result.error.issues) {
    const path = issue.path.map(String).join('.');
    const existing = errors.get(path);
    if (existing === undefined) {
      errors.set(path, [issue.message]);
    } else {
      existing.push(issue.message);
    }
  }
  return errors;
}
