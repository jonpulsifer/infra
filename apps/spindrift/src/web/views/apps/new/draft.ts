/**
 * The creation draft, and the rules that read it.
 *
 * §18 makes this flow "the guided path — Source → Component → Place →
 * Configure → Review — with the compact preflight folded into Review", and the
 * plan adds the constraint that makes it work: **defaults carry every step**.
 * So every field below starts populated, and none of the five steps blocks on
 * the developer typing something. Corrections are available at each step; they
 * are not required at any of them.
 *
 * **Known gap.** Task 38's acceptance criterion says *the draft lives
 * server-side, not in client state — a browser refresh mid-flow must not lose
 * it.* This module is client state, so that criterion is not met yet: it needs
 * a `drafts` table and a pair of commands, and both belong with the App and
 * Component commands of Task 19 rather than in front of them. The shape here is
 * a plain serialisable object with a reducer precisely so moving it is a
 * transport change and not a rewrite.
 */
import type { CreateAppInput } from '../../../../commands/create-app.ts';
import type {
  ComponentKind,
  Exposure,
} from '../../../../domain/desired-state.ts';

/**
 * The flat row of tiles the flow opens with (§18, Task 38).
 *
 * Flat, not a hierarchy: `service` and `website` preselect a kind, `upload` and
 * `repo` let detection propose one (§5), and `discover` is a separate multi-App
 * branch. Presenting them as one row is what keeps "I know what I want" and "I
 * have a directory, you tell me" the same distance from the front door.
 */
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

export type EntryId = (typeof ENTRIES)[number]['id'];

export const STEPS = [
  'Source',
  'Component',
  'Place',
  'Configure',
  'Review',
] as const;

/**
 * Where the code came from (§4, §15).
 *
 * A repo always names its subpath — §5 is explicit that "the scope is named,
 * never searched", so there is no field here for a glob and no button that
 * scans a tree.
 */
export type DraftSource =
  | {
      readonly kind: 'repo';
      /** The owner/name a human reads. */
      readonly repo: string;
      /**
       * The clone URL, carried rather than composed from {@link repo}.
       *
       * Composing it would mean writing a VCS host into the client, and the
       * host an installation integrates with is not this layer's to know — the
       * repository picker (§15, Task 24) has both facts from the API that
       * listed the repository, so it supplies both.
       */
      readonly url: string;
      readonly subpath: string;
    }
  | {
      readonly kind: 'archive';
      readonly filename: string;
      /**
       * Minted when the bundle is staged (§4, Task 18) — the digest is what
       * joins the source receipt to the provenance document, so the draft
       * carries the one the upload produced rather than computing its own.
       */
      readonly digest: string;
    };

/**
 * What detection proposed (§5).
 *
 * `unavailable` carries the same grammar §3 uses for placement: a kind that
 * does not apply stays **visible with its reason** rather than disappearing,
 * because a developer who expected `website` and got `service` needs to read
 * why, not hunt for a missing option.
 */
export interface Detection {
  readonly kind: ComponentKind;
  readonly reason: string;
  readonly available: readonly ComponentKind[];
  readonly unavailable: Readonly<Partial<Record<ComponentKind, string>>>;
}

/**
 * The vessel (§14): the cloud project this App's own resources live in, chosen
 * once and **never again**. Pre-provisioned through Terraform — Spindrift never
 * creates a project (Task 46) — so `ready` is a fact about the platform, and an
 * unready vessel is the prerequisite that stops creation before any Build.
 */
export interface Vessel {
  readonly name: string;
  readonly ready: boolean;
  readonly note: string;
}

/**
 * One configuration key.
 *
 * §10: values are **write-only** and stored one secret per variable, never a
 * blob. The draft therefore holds whether a value was supplied, and never the
 * value itself once it leaves the field — nothing in the UI can read one back,
 * which is the property the store contract exists to guarantee.
 */
export interface DraftConfigKey {
  readonly name: string;
  readonly supplied: boolean;
}

export interface Draft {
  readonly entry: EntryId;
  readonly source: DraftSource;
  readonly appName: string;
  readonly componentName: string;
  readonly detection: Detection;
  readonly kind: ComponentKind;
  readonly vessel: Vessel;
  readonly targetId: string;
  readonly exposure: Exposure;
  readonly config: readonly DraftConfigKey[];
  readonly step: number;
}

export type DraftAction =
  | { type: 'entry'; entry: EntryId }
  | { type: 'field'; field: 'appName' | 'componentName'; value: string }
  | { type: 'kind'; kind: ComponentKind }
  | { type: 'target'; targetId: string }
  | { type: 'exposure'; exposure: Exposure }
  | { type: 'step'; step: number };

/**
 * Choosing an entry tile preselects a kind where the tile names one, and leaves
 * detection's proposal standing where it does not. It never rewrites a kind the
 * developer has already corrected by hand, because the tile row sits at step
 * one and a correction happens at step two.
 */
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
  }
}

/** One thing standing between this draft and a first Build. */
export interface Blocker {
  readonly title: string;
  /** What the developer or an operator does about it. */
  readonly remediation: string;
}

/**
 * The compact preflight, folded into Review (§18).
 *
 * Task 38: **an unmet prerequisite stops before any Build exists**, keeps the
 * draft, and names the remediation path. So this returns blockers rather than
 * throwing or disabling silently — the draft survives, and every entry says
 * what would clear it.
 */
export function blockersFor(
  draft: Draft,
  candidateTargetIds: readonly string[],
): readonly Blocker[] {
  const blockers: Blocker[] = [];

  if (!draft.vessel.ready) {
    blockers.push({
      title: `The vessel project ${draft.vessel.name} is not provisioned.`,
      remediation:
        'Vessels are pre-provisioned through Terraform and adopted by Atlantis. Creation waits for that merge; the draft is kept.',
    });
  }

  if (!candidateTargetIds.includes(draft.targetId)) {
    blockers.push({
      title: 'The chosen Target is not a candidate for this Component.',
      remediation:
        'Pick a Target listed as a candidate on Place, or clear the reason it was excluded.',
    });
  }

  const missing = draft.config.filter((key) => !key.supplied);
  if (missing.length > 0) {
    blockers.push({
      title: `${missing.length} configuration key${missing.length === 1 ? '' : 's'} still needs a value.`,
      remediation: `Supply ${missing.map((key) => key.name).join(', ')} on Configure. Values are write-only once stored, so they cannot be filled in later from here.`,
    });
  }

  return blockers;
}

/**
 * The draft, as `createApp` takes it.
 *
 * This function is small and is the most valuable thing in the file: it is the
 * one place the flow's own shape meets the command's schema, so the compiler
 * checks that Review can actually produce what §21's command demands. A flow
 * that collected the wrong fields would otherwise not find out until somebody
 * pressed the button.
 *
 * Two of the draft's fields are deliberately not here. The Component's kind and
 * the placement belong to the Component and Deploy commands (Task 19) —
 * `createApp` "writes one row and nothing else" — and the config values belong
 * to the store, which core never reads back (§10).
 */
export function createAppInputFor(draft: Draft): CreateAppInput {
  const common = {
    name: draft.appName,
    vesselRef: draft.vessel.name,
  };

  return draft.source.kind === 'repo'
    ? {
        ...common,
        sourceKind: 'repo',
        repoUrl: draft.source.url,
        subpath: draft.source.subpath,
      }
    : {
        ...common,
        sourceKind: 'archive',
        // The digest is minted when the archive is staged (§4, Task 18); the
        // draft carries the upload, and this is where the two are joined.
        archiveDigest: draft.source.digest,
      };
}
