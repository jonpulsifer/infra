/**
 * The server-owned creation draft shared by the command and browser layers.
 *
 * It is deliberately ordinary JSON. Postgres owns the authoritative copy and
 * the browser reducer only proposes replacements guarded by a revision.
 */
import { z } from 'zod';
import type { ComponentKind, Exposure } from './desired-state.ts';

export const ENTRIES = [
  {
    id: 'service',
    label: 'Service',
    note: 'Start with a long-running process',
  },
  { id: 'website', label: 'Website', note: 'Start with a site or frontend' },
  { id: 'upload', label: 'Upload', note: 'ZIP, artifact, or source archive' },
  {
    id: 'repo',
    label: 'Link repo',
    note: 'Detect the kind from one directory',
  },
  {
    id: 'discover',
    label: 'Discover',
    note: 'Propose Apps from a connected repo',
  },
] as const;

export const STEPS = [
  'Source',
  'Component',
  'Place',
  'Configure',
  'Review',
] as const;

const componentKind = z.enum(['service', 'website', 'job']);
const exposure = z.enum(['internal', 'private', 'public']);
const entry = z.enum(['service', 'website', 'upload', 'repo', 'discover']);
const appName = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    'must be lowercase letters, digits and hyphens',
  );

const source = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('repo'),
      repo: z.string().min(1),
      url: z.url(),
      subpath: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('archive'),
      filename: z.string().min(1),
      digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      /** Durable location written by the upload/staging boundary. */
      location: z.string().min(1).nullable().optional(),
      /** Finished output bypasses a builder; source follows the ordinary path. */
      contents: z.enum(['artifact', 'source']).optional(),
      /** Scope after a lone top-level directory is unwrapped. */
      subpath: z.string().min(1).optional(),
    })
    .strict(),
]);

const detection = z
  .object({
    kind: componentKind,
    reason: z.string().min(1),
    available: z.array(componentKind),
    unavailable: z.partialRecord(componentKind, z.string().min(1)),
  })
  .strict();

const vessel = z
  .object({
    name: z.string().min(1),
    ready: z.boolean(),
    note: z.string().min(1),
  })
  .strict();

const configKey = z
  .object({
    name: z.string().min(1),
    supplied: z.boolean(),
  })
  .strict();

export const creationDraftSchema = z
  .object({
    entry,
    source,
    appName,
    componentName: z.string().min(1),
    detection,
    kind: componentKind,
    vessel,
    targetId: z.string(),
    exposure,
    config: z.array(configKey),
    step: z
      .number()
      .int()
      .min(0)
      .max(STEPS.length - 1),
  })
  .strict();

export type Draft = z.infer<typeof creationDraftSchema>;
export type EntryId = Draft['entry'];
export type DraftSource = Draft['source'];
export type Detection = Draft['detection'];
export type Vessel = Draft['vessel'];
export type DraftConfigKey = Draft['config'][number];

export type DraftAction =
  | { type: 'entry'; entry: EntryId }
  | { type: 'field'; field: 'appName' | 'componentName'; value: string }
  | { type: 'kind'; kind: ComponentKind }
  | { type: 'target'; targetId: string }
  | { type: 'exposure'; exposure: Exposure }
  | { type: 'step'; step: number }
  | { type: 'repo'; fullName: string; url: string }
  | { type: 'subpath'; subpath: string };

export const CREATION_BLOCKER_CODES = [
  'VESSEL_UNAVAILABLE',
  'TARGET_UNAVAILABLE',
  'CONFIG_INCOMPLETE',
  'REPOSITORY_UNAVAILABLE',
  'SOURCE_UNAVAILABLE',
  'BUILD_ROUTE_UNAVAILABLE',
] as const;

export type CreationBlockerCode = (typeof CREATION_BLOCKER_CODES)[number];

export interface Blocker {
  readonly code: CreationBlockerCode;
  readonly title: string;
  readonly remediation: string;
}

export interface CreationDraftView {
  readonly id: string;
  readonly revision: number;
  readonly draft: Draft;
  readonly blockers: readonly Blocker[];
  readonly ready: boolean;
}

/** Defaults are selected from current persisted installation capabilities. */
export function initialCreationDraft(input: {
  readonly repository: string | null;
  readonly targetId: string | null;
  readonly vessel: string;
}): Draft {
  const name =
    (input.repository?.split('/').pop() ?? 'app')
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]/g, '-')
      .replaceAll(/^-+|-+$/g, '') || 'app';
  const repo = input.repository;
  return {
    entry: repo ? 'repo' : 'upload',
    source: repo
      ? {
          kind: 'repo',
          repo,
          url: `https://github.com/${repo}.git`,
          subpath: '.',
        }
      : {
          kind: 'archive',
          filename: 'upload.zip',
          digest: `sha256:${'0'.repeat(64)}`,
          location: null,
          contents: 'source',
          subpath: '.',
        },
    appName: name,
    componentName: 'web',
    detection: {
      kind: 'service',
      reason:
        'the default is a long-running service until detection says otherwise',
      available: ['service', 'website', 'job'],
      unavailable: {},
    },
    kind: 'service',
    vessel: {
      name: input.vessel,
      ready: true,
      note: 'the installation home vessel',
    },
    targetId: input.targetId ?? '',
    exposure: 'private',
    config: [],
    step: 0,
  };
}

export function draftReducer(draft: Draft, action: DraftAction): Draft {
  switch (action.type) {
    case 'entry': {
      const kind =
        action.entry === 'service' || action.entry === 'website'
          ? action.entry
          : draft.detection.kind;
      return { ...draft, entry: action.entry, kind };
    }
    case 'field':
      return { ...draft, [action.field]: action.value };
    case 'kind':
      return { ...draft, kind: action.kind };
    case 'target':
      return { ...draft, targetId: action.targetId };
    case 'exposure':
      return { ...draft, exposure: action.exposure };
    case 'step':
      return {
        ...draft,
        step: Math.min(Math.max(action.step, 0), STEPS.length - 1),
      };
    case 'repo': {
      const name = action.fullName.split('/').pop() ?? action.fullName;
      return {
        ...draft,
        source: {
          kind: 'repo',
          repo: action.fullName,
          url: action.url,
          subpath: draft.source.kind === 'repo' ? draft.source.subpath : '.',
        },
        appName: name,
      };
    }
    case 'subpath':
      return draft.source.kind === 'repo'
        ? {
            ...draft,
            source: { ...draft.source, subpath: action.subpath },
          }
        : draft;
  }
}

/** Local blockers are also part of server review; capability blockers are added there. */
export function blockersFor(
  draft: Draft,
  candidateTargetIds: readonly string[],
): readonly Blocker[] {
  const blockers: Blocker[] = [];

  if (!draft.vessel.ready) {
    blockers.push({
      code: 'VESSEL_UNAVAILABLE',
      title: `The vessel project ${draft.vessel.name} is not provisioned.`,
      remediation:
        'Vessels are pre-provisioned through Terraform and adopted by Atlantis. Creation waits for that merge; the draft is kept.',
    });
  }

  if (!candidateTargetIds.includes(draft.targetId)) {
    blockers.push({
      code: 'TARGET_UNAVAILABLE',
      title: 'The chosen Target is not a candidate for this Component.',
      remediation:
        'Pick a Target listed as a candidate on Place, or clear the reason it was excluded.',
    });
  }

  const missing = draft.config.filter((key) => !key.supplied);
  if (missing.length > 0) {
    blockers.push({
      code: 'CONFIG_INCOMPLETE',
      title: `${missing.length} configuration key${missing.length === 1 ? '' : 's'} still needs a value.`,
      remediation: `Supply ${missing.map((key) => key.name).join(', ')} on Configure. Values are write-only once stored, so they cannot be filled in later from here.`,
    });
  }

  if (draft.source.kind === 'archive' && !draft.source.location) {
    blockers.push({
      code: 'SOURCE_UNAVAILABLE',
      title: `${draft.source.filename} has not been staged.`,
      remediation:
        'Upload the archive on Source before Review. The draft is kept while the upload is incomplete.',
    });
  }

  return blockers;
}
