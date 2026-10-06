/**
 * Finds and parses a scope's kthx file. Once it exists the file is the source
 * of truth, so malformed or unknown input stops reconciliation.
 */
import { z } from 'zod';
import type { DetectionProposal } from './ladder.ts';

/**
 * The names a scope's declaration may have, first match wins. New scopes are
 * written as the first; the second is read forever.
 */
export const DECLARATION_FILES = ['kthx.yaml', 'spindrift.yaml'] as const;

export const DECLARATION_FILE = DECLARATION_FILES[0];

/** `.` is the repository root. */
export function declarationPath(
  scope: string,
  file: string = DECLARATION_FILE,
): string {
  return scope === '.' ? file : `${scope}/${file}`;
}

export interface Declaration {
  /** Repo-relative. */
  readonly path: string;
  readonly document: string;
}

/** A read that throws stops the search, so the caller decides what it means. */
export async function readDeclaration(
  scope: string,
  read: (path: string) => Promise<string | null>,
): Promise<Declaration | null> {
  for (const file of DECLARATION_FILES) {
    const path = declarationPath(scope, file);
    const document = await read(path);
    if (document !== null) return { path, document };
  }
  return null;
}

const scopedPathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !/^[A-Za-z]:[\\/]/.test(value) &&
      !value.split(/[\\/]/).includes('..'),
    'path must stay inside its scope',
  );

const componentSchema = z.strictObject({
  kind: z.enum(['service', 'website', 'job']),
});

const buildSchema = z.discriminatedUnion('frontend', [
  z.strictObject({
    frontend: z.literal('dockerfile'),
    file: scopedPathSchema,
  }),
  z.strictObject({
    frontend: z.literal('railpack'),
    command: z.string().min(1).nullable(),
    outputDirectory: z.string().min(1).nullable(),
  }),
]);

const kthxFileSchema = z.strictObject({
  version: z.literal(1),
  component: componentSchema,
  build: buildSchema,
  watchPaths: z.array(scopedPathSchema).min(1),
});

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'document';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

export function parseKthxFile(
  document: string,
  source: string = DECLARATION_FILE,
): DetectionProposal {
  let decoded: unknown;
  try {
    decoded = Bun.YAML.parse(document);
  } catch (cause) {
    throw new Error(
      `${source}: not valid YAML: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }

  const parsed = kthxFileSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error(
      `${source}: invalid kthx file: ${formatIssues(parsed.error)}`,
    );
  }

  const { component, build, watchPaths } = parsed.data;
  return {
    source: 'kthx-file',
    kind: component.kind,
    reason: `${source} asserts this scope is a ${component.kind}`,
    kinds: [
      {
        kind: component.kind,
        available: true,
        reason: `asserted by ${source.slice(source.lastIndexOf('/') + 1)}`,
      },
    ],
    build:
      build.frontend === 'dockerfile'
        ? { frontend: 'dockerfile', dockerfile: build.file }
        : {
            frontend: 'railpack',
            buildCommand: build.command,
            outputDirectory: build.outputDirectory,
          },
    watchPaths,
  };
}
