/**
 * The server-owned creation draft shared by the command and browser layers.
 * Postgres holds the authoritative copy; the browser reducer proposes
 * replacements guarded by a revision.
 */
import { z } from 'zod';
import type { Auth, ComponentKind, Reach } from './desired-state.ts';
import { digestSchema } from './digest.ts';

export const ENTRIES = [
  {
    id: 'repo',
    label: 'GitHub repository',
    note: 'Deploy a directory from a repository',
  },
  {
    id: 'upload',
    label: 'Upload an archive',
    note: 'ZIP or tarball, built the same way',
  },
] as const;

// Exported so placement validates against the same words the draft does.
export const componentKind = z.enum(['service', 'website', 'job']);
export const reach = z.enum(['none', 'private', 'public']);
export const auth = z.enum(['none', 'proxy']);
/** Includes values no tile offers, so stored drafts still parse. */
const entry = z.enum(['service', 'website', 'upload', 'repo', 'discover']);

/** Exported so the screen checks the same rule. Its messages render beside the input. */
export const appNameSchema = z
  .string()
  .trim()
  .min(1, 'the App needs a name')
  .max(63, 'at most 63 characters')
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    'must be lowercase letters, digits and hyphens',
  );

export const componentNameSchema = z
  .string()
  .min(1, 'the Component needs a name');

const source = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('repo'),
      /** Empty until one is picked; `blockersFor` refuses to create while it is. */
      repo: z.string(),
      url: z.union([z.url(), z.literal('')]),
      subpath: z.string().min(1),
      /**
       * Creating the App also connects the repository. Nothing is written until
       * Deploy, so an abandoned draft leaves no row and no configuration PR.
       */
      connect: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('archive'),
      filename: z.string().min(1),
      digest: digestSchema,
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
    /** The directory `reason` describes. Absent means nothing has read one. */
    scope: z.string().min(1).optional(),
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
    appName: appNameSchema,
    componentName: componentNameSchema,
    detection,
    kind: componentKind,
    vessel,
    targetId: z.string(),
    reach,
    auth,
    config: z.array(configKey),
    /** The source the last tile switch put down, restored on switching back. */
    stashed: source.optional(),
    /**
     * Set once the operator types a name, which a new repository or scope then
     * keeps. Absent on older drafts.
     */
    appNameByOperator: z.boolean().optional(),
    /** The same for the directory. Cleared when the repository changes. */
    scopeByOperator: z.boolean().optional(),
  })
  .strict();

/**
 * Non-strict, so a stored row drops a retired key on read and the strict save
 * schema still accepts the draft. Every retired key was optional.
 */
const storedDraftSchema = z.object(creationDraftSchema.shape);

export function storedDraft(draft: Draft): Draft {
  const parsed = storedDraftSchema.safeParse(draft);
  return parsed.success ? (parsed.data as Draft) : draft;
}

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
  | { type: 'reach'; reach: Reach }
  | { type: 'auth'; auth: Auth }
  | { type: 'repo'; fullName: string; url: string; connect?: boolean }
  /** Only a `settled` edit counts as the operator's answer; a keystroke does not. */
  | { type: 'subpath'; subpath: string; settled?: boolean }
  | {
      type: 'detect';
      scope: string;
      kind: ComponentKind;
      reason: string;
      unavailable: Readonly<Partial<Record<ComponentKind, string>>>;
    }
  | {
      type: 'archive';
      filename: string;
      digest: string;
      location?: string | null;
      contents?: 'artifact' | 'source';
    };

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

/** A draft that has read nothing about its tree. The unset `scope` says so to the browser. */
function openingDetection(): Detection {
  return {
    kind: 'service',
    reason:
      'the default is a long-running service until detection says otherwise',
    available: ['service', 'website', 'job'],
    unavailable: {},
  };
}

/**
 * Opens with no repository chosen, so `blockersFor` refuses to create until one
 * is. The Target and vessel come from the installation.
 */
export function initialCreationDraft(input: {
  readonly targetId: string | null;
  readonly vessel: string;
}): Draft {
  return {
    entry: 'repo',
    source: blankSource('repo'),
    // A placeholder that parses; picking a repository replaces it.
    appName: 'app',
    componentName: 'web',
    detection: openingDetection(),
    kind: 'service',
    vessel: {
      name: input.vessel,
      ready: true,
      note: 'the installation home vessel',
    },
    targetId: input.targetId ?? '',
    reach: OPENING_REACH,
    auth: OPENING_AUTH,
    config: [],
  };
}

/** Exported so a screen can tell an untouched default from a decision. */
export const OPENING_REACH: Reach = 'private';
export const OPENING_AUTH: Auth = 'proxy';

function emptyArchive(): DraftSource {
  return {
    kind: 'archive',
    filename: 'upload.zip',
    digest: `sha256:${'0'.repeat(64)}`,
    location: null,
    contents: 'source',
    subpath: '.',
  };
}

/** `null` for a tile that names a Component kind and no source. */
function sourceKindFor(entry: EntryId): DraftSource['kind'] | null {
  if (entry === 'upload') return 'archive';
  return entry === 'repo' || entry === 'discover' ? 'repo' : null;
}

function blankSource(kind: DraftSource['kind']): DraftSource {
  return kind === 'archive'
    ? emptyArchive()
    : { kind: 'repo', repo: '', url: '', subpath: '.' };
}

export function draftReducer(draft: Draft, action: DraftAction): Draft {
  switch (action.type) {
    // A source tile switches the source and stashes the old one, so switching
    // back loses nothing.
    case 'entry': {
      // Only a kind tile sets the kind, and never to one detection ruled out.
      const named =
        action.entry === 'service' || action.entry === 'website'
          ? action.entry
          : null;
      const kind =
        named !== null && draft.detection.unavailable[named] === undefined
          ? named
          : draft.kind;
      const wanted = sourceKindFor(action.entry);
      if (wanted === null || wanted === draft.source.kind) {
        return { ...draft, entry: action.entry, kind };
      }
      return {
        ...draft,
        entry: action.entry,
        kind,
        source:
          draft.stashed?.kind === wanted ? draft.stashed : blankSource(wanted),
        stashed: draft.source,
      };
    }
    case 'field':
      return {
        ...draft,
        [action.field]: action.value,
        // A typed App name is never derived again.
        ...(action.field === 'appName' ? { appNameByOperator: true } : {}),
      };
    case 'kind':
      return { ...draft, kind: action.kind };
    case 'target':
      return { ...draft, targetId: action.targetId };
    // Reach `none` clears auth too, or create would refuse the draft.
    case 'reach':
      return {
        ...draft,
        reach: action.reach,
        ...(action.reach === 'none' ? { auth: 'none' as const } : {}),
      };
    case 'auth':
      return { ...draft, auth: action.auth };
    case 'detect': {
      // The kind follows detection: an earlier correction was about another directory.
      const available = (['service', 'website', 'job'] as const).filter(
        (kind) => action.unavailable[kind] === undefined,
      );
      return {
        ...draft,
        kind: action.kind,
        detection: {
          kind: action.kind,
          reason: action.reason,
          available,
          unavailable: action.unavailable,
          scope: action.scope,
        },
        // A detected scope names the Component: `apps/api` is `api`.
        componentName:
          action.scope === '.'
            ? draft.componentName
            : (action.scope.split('/').pop() ?? draft.componentName),
        source:
          draft.source.kind === 'repo'
            ? { ...draft.source, subpath: action.scope }
            : draft.source,
      };
    }
    case 'repo': {
      const name = action.fullName.split('/').pop() ?? action.fullName;
      return {
        ...draft,
        source: {
          kind: 'repo',
          repo: action.fullName,
          url: action.url,
          // Back to the root: the old directory was a path in the old repository.
          subpath: '.',
          ...(action.connect === true ? { connect: true as const } : {}),
        },
        appName: draft.appNameByOperator ? draft.appName : name,
        scopeByOperator: undefined,
        // A kept scope would mark the new repository as already read.
        detection: openingDetection(),
      };
    }
    // A settled directory is the operator's answer and outlives detection and
    // reopening the draft.
    case 'subpath':
      return draft.source.kind === 'repo'
        ? {
            ...draft,
            source: { ...draft.source, subpath: action.subpath },
            ...(action.settled === true ? { scopeByOperator: true } : {}),
          }
        : draft;
    case 'archive':
      return {
        ...draft,
        entry: 'upload',
        source: {
          kind: 'archive',
          filename: action.filename,
          digest: action.digest,
          location:
            action.location ??
            (draft.source.kind === 'archive' ? draft.source.location : null),
          contents:
            action.contents ??
            (draft.source.kind === 'archive'
              ? draft.source.contents
              : 'source'),
          subpath: draft.source.kind === 'archive' ? draft.source.subpath : '.',
        },
      };
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
      title: `${draft.vessel.name} is not ready to take an App yet.`,
      remediation:
        'Vessels are pre-provisioned through Terraform and adopted by Atlantis. Creation waits for that merge; the draft is kept.',
    });
  }

  if (!candidateTargetIds.includes(draft.targetId)) {
    blockers.push({
      code: 'TARGET_UNAVAILABLE',
      title: 'Nothing chosen can run this App.',
      remediation:
        'Open \u201cWhere it runs\u201d and pick one of the places listed as able to run it. Each one that cannot says why.',
    });
  }

  if (draft.source.kind === 'repo' && draft.source.repo === '') {
    blockers.push({
      code: 'SOURCE_UNAVAILABLE',
      title: 'No repository is chosen.',
      remediation:
        'Pick one above. Every repository the GitHub App installation grants is listed, whether Spindrift has connected it or not.',
    });
  }

  const missing = draft.config.filter((key) => !key.supplied);
  if (missing.length > 0) {
    blockers.push({
      code: 'CONFIG_INCOMPLETE',
      title: `${missing.length} configuration key${missing.length === 1 ? '' : 's'} still needs a value.`,
      // Nothing on this screen accepts a value, so the App's Config screen is named.
      remediation: `Supply ${missing.map((key) => key.name).join(', ')} from the App's Config screen once it exists. Values are write-only once stored, so they cannot be filled in later from here.`,
    });
  }

  if (draft.source.kind === 'archive' && !draft.source.location) {
    blockers.push({
      code: 'SOURCE_UNAVAILABLE',
      title: `${draft.source.filename} has not been staged.`,
      remediation:
        'Finish the upload before deploying. The draft is kept while it is incomplete.',
    });
  }

  return blockers;
}
