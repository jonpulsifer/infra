/**
 * The server-owned creation draft shared by the command and browser layers.
 *
 * It is deliberately ordinary JSON. Postgres owns the authoritative copy and
 * the browser reducer only proposes replacements guarded by a revision.
 */
import { z } from 'zod';
import type { Auth, ComponentKind, Reach } from './desired-state.ts';
import { digestSchema } from './digest.ts';

/**
 * The tiles offered for where the code comes from.
 *
 * Two, because that is how many axes there are. `Service` and `Website` sat
 * here too and only ever set the *kind* — the thing detection answers before
 * anybody presses anything — so the row read as a choice between four things
 * when it was two questions wearing one grammar. The kind is corrected under
 * Type, where the reasons a kind is unavailable are already on screen.
 *
 * The `entry` enum keeps all five values for the reason it already kept
 * `discover`: drafts are durable rows, and a value dropped from the enum is a
 * stored draft that no longer parses. What is offered is not what is legal.
 */
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

// Exported because §3's requirements are derived from exactly these three, so
// any command that resolves placement validates them against the same words the
// draft does.
export const componentKind = z.enum(['service', 'website', 'job']);
export const reach = z.enum(['none', 'private', 'public']);
export const auth = z.enum(['none', 'proxy']);
/**
 * `discover` is accepted and never offered.
 *
 * It pressed the same reducer arm as `repo` and produced the same screen —
 * choosing a repository lists every directory read from it either way — so the
 * two tiles were one tile drawn twice, and the pair read as a choice with
 * consequences. It stays in the vocabulary because drafts are durable rows: a
 * value dropped from the enum is a stored draft that no longer parses.
 */
const entry = z.enum(['service', 'website', 'upload', 'repo', 'discover']);

/**
 * The App name's rule, exported because the screen checks it too.
 *
 * One statement of the rule, read from both ends: the browser marks the field
 * as the operator types and the command refuses the document, and a second copy
 * of the regex is how those two come to disagree. The messages are written for
 * a reader because this is the one schema whose complaints are rendered beside
 * an input rather than logged.
 */
export const appNameSchema = z
  .string()
  .trim()
  .min(1, 'the App needs a name')
  .max(63, 'at most 63 characters')
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    'must be lowercase letters, digits and hyphens',
  );

/** The Component name's rule. Read beside the field for the same reason. */
export const componentNameSchema = z
  .string()
  .min(1, 'the Component needs a name');

const source = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('repo'),
      /**
       * Empty until one is picked.
       *
       * "Deploy from a repository, and I have not said which" is a state the
       * flow genuinely has — the `Link repo` and `Discover` tiles open on it
       * from an upload draft — and a schema that could not hold it would make
       * those tiles unable to switch the source at all. `blockersFor` refuses
       * to create anything while it is empty.
       */
      repo: z.string(),
      url: z.union([z.url(), z.literal('')]),
      subpath: z.string().min(1),
      /**
       * Whether creating the App also connects the repository (§15).
       *
       * Set when the operator picks a repository GitHub grants and Spindrift
       * holds no row for. Browsing one writes nothing; Deploy is the committing
       * act, and it is there that the row and the configuration PR appear. An
       * abandoned draft leaves neither.
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
    /**
     * The directory the sentence above is about.
     *
     * Absent means nothing has read one — which is what a fresh draft means by
     * "until detection says otherwise", and what every draft written before
     * `inspectRepository` existed means too. Present, it is what makes the
     * reason checkable against the directory the draft names: a sentence about
     * `apps/hub` shown under a root directory reading `docs` is a sentence
     * about somewhere else.
     */
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
    /**
     * The source the last tile switch put down.
     *
     * Pressing `Upload` on a repository draft and then `Link repo` again is
     * somebody looking rather than changing their mind, and a tile that costs
     * them a staged archive or a chosen repository for the look is a tile
     * nobody presses twice. Optional, and unset on a draft that has never
     * switched.
     */
    stashed: source.optional(),
    /**
     * Whether the App name is the operator's word rather than a derivation.
     *
     * Optional because drafts are durable rows and an older one predates the
     * flag; absent reads as "nothing has been typed", which is what every one
     * of those drafts means. Once set, choosing another repository or another
     * scope leaves the name alone: a name somebody typed is an answer, and
     * re-deriving over it is the flow overwriting a decision it asked for.
     */
    appNameByOperator: z.boolean().optional(),
    /**
     * Whether the directory is the operator's word rather than a proposal.
     *
     * The same discipline as `appNameByOperator`, and durable for the same
     * reason: a draft is a row somebody comes back to, so a flag that lived
     * only in the open tab would let reopening the draft move a directory they
     * typed. Cleared whenever the repository changes, because a path is a
     * statement about one tree.
     */
    scopeByOperator: z.boolean().optional(),
  })
  .strict();

/**
 * The same document, read from a stored row.
 *
 * Drafts are durable jsonb, so a row written before a key was retired still
 * carries it — and the strict schema above, which is what a save is validated
 * against, would refuse the operator's own draft the moment they touched it.
 * Reading through this drops what is no longer named, so the browser never
 * receives a key it would hand straight back. That is the whole migration: the
 * column is jsonb and every retired key was optional.
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
  /**
   * A directory being typed, and — once — the operator having finished typing.
   *
   * `settled` is what counts as the answer. Taking every keystroke as one meant
   * the first character of `apps/web` marked the draft answered: the "nothing
   * is chosen to deploy from here" prerequisite cleared and, once the debounced
   * save landed, Deploy went green for a path nothing had read.
   */
  | { type: 'subpath'; subpath: string; settled?: boolean }
  /**
   * What the detector found, applied.
   *
   * This is the action that makes the one screen honest. The draft has always
   * carried a `detection` block and, until `inspectRepository` existed,
   * nothing could ever fill it — every new draft started life claiming to be a
   * service "until detection says otherwise", and detection never said.
   */
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

/**
 * What a draft claims about a repository nothing has read.
 *
 * One statement of it, because two states mean it: a draft that has just been
 * created, and a draft that has just been pointed at another repository. Both
 * have read nothing about the tree they name, and `scope: undefined` is what
 * says so — it is the flag the browser's read consults before proposing.
 */
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
 * What a draft opens on, before anybody has said where the code is.
 *
 * **No repository is chosen for you.** This used to open on whichever active
 * repository sorted first — the App was named after it, the screen read it
 * before anybody pressed anything, and every row below claimed an answer about
 * a tree nobody had picked. That is the whole reason the screen read as
 * pre-answered and wrong: it *was* pre-answered, about the wrong thing.
 *
 * So the source opens blank and `blockersFor` refuses to create from it, which
 * is the state the schema already documents as legal. A blank source is not an
 * archive: `Upload an archive` is a tile somebody presses, and opening on the
 * archive branch made the picker something you had to switch back to.
 *
 * The Target and vessel are still selected from current installation
 * capabilities — those are facts about the installation rather than answers
 * about this App, and there is nothing for a person to pick between.
 */
export function initialCreationDraft(input: {
  readonly targetId: string | null;
  readonly vessel: string;
}): Draft {
  return {
    entry: 'repo',
    source: blankSource('repo'),
    // A placeholder that parses, and never survives: picking a repository
    // derives the name from it, and nothing can be created from a blank source.
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

/**
 * What a draft opens on, named so a screen can tell a default from a decision.
 *
 * These two rows state a definition of their value and the same sentence
 * renders whichever way it got there, so "still the value it was born with" is
 * the only signal available that nobody has looked at it. Exported rather than
 * inlined twice, because a default that drifts from what the screen calls a
 * default is a screen that lies quietly.
 */
export const OPENING_REACH: Reach = 'private';
export const OPENING_AUTH: Auth = 'proxy';

/** An archive nobody has staged yet — what the `Upload` tile opens on. */
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

/**
 * The kind of source a tile is about, or `null` when it is about the kind of
 * Component instead — `Service` and `Website` name what is being deployed and
 * never where it comes from.
 */
function sourceKindFor(entry: EntryId): DraftSource['kind'] | null {
  if (entry === 'upload') return 'archive';
  return entry === 'repo' || entry === 'discover' ? 'repo' : null;
}

/** Neither an archive nor a repository yet — what a switched tile opens on. */
function blankSource(kind: DraftSource['kind']): DraftSource {
  return kind === 'archive'
    ? emptyArchive()
    : { kind: 'repo', repo: '', url: '', subpath: '.' };
}

export function draftReducer(draft: Draft, action: DraftAction): Draft {
  switch (action.type) {
    // A tile that names a source switches to it, whatever the draft was on
    // before: a tile that changes a label and leaves the surface underneath it
    // belonging to the other kind of source is a tile that lies. The source it
    // switches away from is kept, so that pressing the other tile and coming
    // back is a look rather than a loss.
    case 'entry': {
      // A tile that names a kind names it, and one that names a source says
      // nothing about the kind at all. Falling back to `detection.kind` made
      // `Upload` and `Link repo` silently revert a kind the operator had
      // corrected two rows down, taking the "corrected" badge with it and
      // reporting nothing. A named kind detection has ruled out is ignored for
      // the same reason the Component row disables it: a tile that is selected
      // and greyed at once, wearing the reason it cannot be chosen, is not an
      // answer anybody gave.
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
        // Typing the App name is the operator answering the question, so
        // nothing derives it again afterwards.
        ...(action.field === 'appName' ? { appNameByOperator: true } : {}),
      };
    case 'kind':
      return { ...draft, kind: action.kind };
    case 'target':
      return { ...draft, targetId: action.targetId };
    // Choosing no route drops the filter with it. The alternative is a draft
    // that looks complete and is refused at create — the same refusal, moved to
    // the point where the developer can no longer see what caused it.
    case 'reach':
      return {
        ...draft,
        reach: action.reach,
        ...(action.reach === 'none' ? { auth: 'none' as const } : {}),
      };
    case 'auth':
      return { ...draft, auth: action.auth };
    case 'detect': {
      // The kind moves with the proposal. A developer who had already
      // corrected it and then changed the source has changed the thing being
      // corrected, so carrying the old correction forward would silently apply
      // an answer about a different directory.
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
        // A detected scope names the Component: `apps/api` is `api`, and a
        // root scope keeps whatever the repository is called.
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
          // Back to the root: the directory the draft named is a statement
          // about the repository that was selected before this one, and
          // carrying it over would name a path in a tree nobody has read.
          subpath: '.',
          ...(action.connect === true ? { connect: true as const } : {}),
        },
        appName: draft.appNameByOperator ? draft.appName : name,
        // The directory went back to the root with the tree it named, so
        // whoever typed the old one has not typed this one.
        scopeByOperator: undefined,
        // And so did the read. The sentence, the ruled-out kinds and the scope
        // are all statements about the previous repository, and the scope is
        // what makes a draft count as answered — carried over, the read of the
        // repository just chosen finds the question already settled and applies
        // nothing, leaving the rows below describing somewhere else.
        detection: openingDetection(),
      };
    }
    // Naming a directory is the operator answering where the App is, so it
    // stands however detection reads it (story 32) and it survives the draft
    // being closed and reopened. Half a path on the way to one is not that
    // answer, so the flag waits for the edit to settle.
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
      // Not "under Config": that disclosure lists keys and holds no input, and
      // no action on this screen can supply one. The App's own Config screen is
      // where a value goes, and saying so beats naming a control that cannot do
      // it.
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
