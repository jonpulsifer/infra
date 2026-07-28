/**
 * The authoritative, in-repo projection of one scope's detection config (§5).
 *
 * This boundary is intentionally strict. Once `spindrift.yaml` exists the repo
 * is the source of truth, so malformed or unknown input must stop
 * reconciliation rather than quietly falling through to a fresh guess.
 */
import { z } from 'zod';
import type { DetectionProposal } from './ladder.ts';

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

const spindriftFileSchema = z.strictObject({
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

export function parseSpindriftFile(
  document: string,
  source = 'spindrift.yaml',
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

  const parsed = spindriftFileSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error(
      `${source}: invalid Spindrift file: ${formatIssues(parsed.error)}`,
    );
  }

  const { component, build, watchPaths } = parsed.data;
  return {
    source: 'spindrift-file',
    kind: component.kind,
    kinds: [
      {
        kind: component.kind,
        available: true,
        reason: 'asserted by spindrift.yaml',
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

export async function loadSpindriftFile(
  path: string,
): Promise<DetectionProposal> {
  return parseSpindriftFile(await Bun.file(path).text(), path);
}
