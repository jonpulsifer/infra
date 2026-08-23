/**
 * Deploying a new App: one question, then a card of answers.
 *
 * §18 named the creation flow Source → Component → Place → Configure → Review.
 * The rail went away — stories 31 and 32 say what the sequence was *for*,
 * "defaults carrying every step" and "corrections hidden behind progressive
 * disclosure", and five screens with a Continue button under each turned out to
 * be the rendering that made every default look like a question.
 *
 * What replaced it was nine pre-answered rows, and that had a worse problem:
 * **it was pre-answered about the wrong repository**. `startCreationDraft`
 * opened every draft on whichever active repository sorted first, so the screen
 * arrived named after a repo nobody picked, having already read it, with eight
 * rows below stating consequences of that choice. Reading down it was not
 * confirming a plan; it was auditing somebody else's.
 *
 * So the screen has two shapes. **Until there is a source there is one
 * question** — which repository, or an archive — and the picker is the entire
 * page, because nothing below it can be true yet. **Once there is one**, four
 * rows say what will happen: Code, Type, Name, Where it runs. Each states the
 * answer *and why it is the answer*, and each opens its correction in place.
 *
 * Five rows became one. Reach, Auth, Target, URL and Vessel are five facts
 * about a single question — where does this run and who can reach it — and
 * promoting each to its own row asked a person to hold five platform nouns to
 * read one sentence. `Where it runs` states that sentence and keeps every one
 * of those controls, unchanged, one Edit away.
 *
 * **The rows are in dependency order.** Placement is derived from kind, reach
 * and auth (§3) — the `listTargets` refetch below *is* that derivation — so
 * Where it runs comes last. Name is no longer first: it is derived from the
 * repository, and asking somebody to name a thing before saying what it is was
 * the order the old screen had.
 *
 * The reason any of this is honest is `inspectRepository`. The draft has always
 * carried a `detection` block and nothing could ever fill it, so every draft
 * opened claiming to be a service "until detection says otherwise" and
 * detection never said. Choosing a repository here runs the real §5 ladder over
 * the real default branch, and the kind, the scope, the build frontend and the
 * ruled-out kinds are what it found.
 */
import { Loader2, Rocket, Search } from 'lucide-react';
import { type Dispatch, useEffect, useRef, useState } from 'react';
import type { ZodType } from 'zod';
import type {
  GrantedRepositoryView,
  RepositoryOptionView,
  TargetOptionView,
} from '../../../../commands/views.ts';
import type {
  Blocker,
  CreationBlockerCode,
  CreationDraftView,
  DraftAction,
} from '../../../../domain/creation-draft.ts';
import {
  appNameSchema,
  componentNameSchema,
  OPENING_AUTH,
  OPENING_REACH,
} from '../../../../domain/creation-draft.ts';
import {
  type ClientResult,
  command,
  type TransportFailure,
} from '../../../client.ts';
import {
  RepoPicker,
  type RepositoryChoice,
  repositoryChoices,
} from '../../../components/repo-picker.tsx';
import { reportSessionExpired } from '../../../session-events.ts';
import { Badge } from '../../../ui/badge.tsx';
import { Button } from '../../../ui/button.tsx';
import { Card, Eyebrow } from '../../../ui/card.tsx';
import { Declaration } from '../../../ui/declaration.tsx';
import { ErrorState } from '../../../ui/error-state.tsx';
import { Field } from '../../../ui/field.tsx';
import { notify } from '../../../ui/toast.tsx';
import { cn } from '../../../ui/utils.ts';
import { deployDraft } from './deploy.ts';
import {
  type InspectedScope,
  inspection,
  mergeScopes,
  outcomeOf,
  spindriftFileFor,
} from './detect.ts';
import { blockersFor, type Draft, draftReducer, ENTRIES } from './draft.ts';
import {
  ADAPTER_LABEL,
  AUTH_LABEL,
  AUTH_NOTE,
  AUTHS,
  Choice,
  KIND_LABEL,
  KIND_NOTE,
  KINDS,
  REACH_LABEL,
  REACH_NOTE,
  REACHES,
  Row,
  VesselNote,
} from './summary.tsx';
import { type DraftWrites, draftWrites } from './writes.ts';

/** The four rows the card is, as ids the parent can hold one of. */
type PlanRow = 'code' | 'type' | 'name' | 'where';

/**
 * Which row each unmet prerequisite belongs beside.
 *
 * Total over {@link CreationBlockerCode} rather than a lookup with a fallback,
 * so a seventh blocker code is a compile error here instead of a sentence that
 * renders nowhere. That is the failure the foot-of-page stack could not have:
 * it showed everything, which is why it also showed everything eight sections
 * away from the thing it was about.
 */
const BLOCKER_ROW = {
  SOURCE_UNAVAILABLE: 'code',
  REPOSITORY_UNAVAILABLE: 'code',
  BUILD_ROUTE_UNAVAILABLE: 'code',
  TARGET_UNAVAILABLE: 'where',
  VESSEL_UNAVAILABLE: 'where',
  // Nothing on this screen supplies a value — the App's own Config tab does —
  // so it sits with the thing it is about, which is the App as a whole.
  CONFIG_INCOMPLETE: 'name',
} as const satisfies Record<CreationBlockerCode, PlanRow>;

/**
 * What stands between a repository with several Apps in it and a Deploy.
 *
 * The draft names a directory from the moment it exists — the root — and
 * deploying that because nobody corrected it is the silent first-hit this
 * screen refuses to make. So while detection is offering more than one
 * candidate and the draft names none of them, there is a prerequisite to clear,
 * stated the way every other unmet prerequisite on this screen is.
 *
 * A directory the operator typed is an answer, however detection reads it, and
 * a repository detection could make nothing of leaves the assertion path open:
 * §5's ladder proposes, and story 32 keeps the escape hatch.
 */
function unchosenScope(
  draft: Draft,
  detected: readonly InspectedScope[],
  named: boolean,
): readonly Blocker[] {
  if (draft.source.kind !== 'repo' || named || detected.length < 2) return [];
  if (detected.some((scope) => scope.scope === draft.source.subpath)) return [];
  return [
    {
      code: 'SOURCE_UNAVAILABLE',
      title: `Nothing is chosen to deploy from ${draft.source.repo}.`,
      remediation: `Detection found ${detected.length} directories it knows how to build. Pick one below, or name a directory yourself.`,
    },
  ];
}

/**
 * What went wrong with the read, split on whether there was one.
 *
 * The two are different answers and only one of them is a prerequisite. A
 * repository that could not be read leaves every row below Source standing on
 * the draft's opening claim — a kind nothing checked, a directory nothing
 * looked in — so Deploy would build a guess. A repository that *was* read and
 * holds nothing buildable is the assertion path §5 keeps open: name the
 * directory, pick the kind, and Spindrift builds what you said.
 */
export interface DetectionTrouble {
  readonly kind: 'unread' | 'unsupported';
  readonly message: string;
  /** The repository the read was about. */
  readonly repo: string;
  /**
   * The directory it asked about, absent when it asked about the tree.
   *
   * What makes the sentence checkable against the draft rather than cleared on
   * a guess: a complaint about `docs` stops being on screen when the root
   * directory stops saying `docs`, and one about the repository as a whole does
   * not, because naming a directory in it did not read it.
   */
  readonly scope?: string;
}

/**
 * The last read's complaint, while the draft still names what it is about.
 *
 * Derived rather than cleared per action, which is the whole of the fix: an
 * enumeration of the actions that "move the input" cannot tell a sentence about
 * a directory from a sentence about a repository, and clearing an unreadable
 * repository on a keystroke in the root directory field re-enables Deploy on
 * the draft's opening claim — a kind nothing checked, in a tree nothing read.
 */
export function standingTrouble(
  draft: Draft,
  trouble: DetectionTrouble | null,
): DetectionTrouble | null {
  if (trouble === null || draft.source.kind !== 'repo') return null;
  if (draft.source.repo !== trouble.repo) return null;
  return trouble.scope === undefined || trouble.scope === draft.source.subpath
    ? trouble
    : null;
}

function unreadRepository(
  draft: Draft,
  trouble: DetectionTrouble | null,
): readonly Blocker[] {
  if (draft.source.kind !== 'repo' || trouble?.kind !== 'unread') return [];
  return [
    {
      code: 'REPOSITORY_UNAVAILABLE',
      title: `Spindrift could not read ${draft.source.repo}.`,
      // The message itself is already on screen, as the Source row's reason.
      // Repeating it here read as two separate problems with one repository.
      remediation:
        'Until it can be read, nothing below came from the repository.',
    },
  ];
}

/** Whether anything has answered which directory this draft deploys. */
function answeredScope(draft: Draft): boolean {
  return draft.scopeByOperator === true || draft.detection.scope !== undefined;
}

/** The schema's own complaint about one value, or `null`. */
function issueWith(schema: ZodType<string>, value: string): string | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? null);
}

/**
 * What creating the App did to the repository, said once, on the way out.
 *
 * Deploy is the only place a repository GitHub merely grants gets connected,
 * and connecting opens the one configuration pull request §15 makes
 * authoritative on merge. `connectRepository` fails open on that pull request —
 * the repository stays connected either way — so a silence here is the
 * difference between "merge this" and "your builds will never run on your own
 * repository", and neither was ever said on this screen.
 */
function reportConfigPullRequest(app: {
  readonly configPullRequest: number | null;
  readonly configPullRequestError: string | null;
  readonly configRepository: string | null;
}): void {
  const { configPullRequest, configPullRequestError, configRepository } = app;
  if (configRepository === null) return;
  if (configPullRequest !== null) {
    const url = `https://github.com/${configRepository}/pull/${configPullRequest}`;
    notify({
      tone: 'success',
      title: `Configuration PR opened: ${configRepository}#${configPullRequest}`,
      detail:
        'Merging it puts the Spindrift file and the build workflow on the default branch. Until then nothing in this repository is authoritative, and its builds run on the platform repository.',
      action: {
        label: 'Review it',
        onSelect: () => {
          window.open(url, '_blank', 'noopener,noreferrer');
        },
      },
    });
    return;
  }
  if (configPullRequestError !== null) {
    notify({
      tone: 'destructive',
      title: `${configRepository} is connected, but its configuration PR did not open`,
      detail: `${configPullRequestError} Open it again from Repositories, or add the Spindrift file and the build workflow by hand.`,
    });
  }
}

/** A refusal, and what the operator was doing when it arrived. */
interface Refused {
  readonly failure: TransportFailure;
  readonly title?: string;
}

/** The two reads this screen opens with, in the order they are made. */
export type CreationLoad = 'draft' | 'options';

const LOADING_NOTE = {
  draft: 'Recovering the draft…',
  options: 'Reading the Targets and repositories it can use…',
} as const satisfies Record<CreationLoad, string>;

/**
 * The screen's own shape, while the two reads it opens with are in flight.
 *
 * A screen that is a card of decided rows loads as a card of rows: one pulsing
 * sentence says a page is coming and nothing about what will be on it, and the
 * layout shift when the real rows arrive is the reader losing their place. The
 * caption names the read actually outstanding, because the second one cannot
 * start until the first has answered — the draft says what to resolve placement
 * for (§3) — so "still loading" has two different meanings here.
 */
export function CreationSkeleton({ phase }: { phase: CreationLoad }) {
  return (
    <div
      aria-busy="true"
      className="mx-auto flex w-full max-w-[760px] flex-col gap-5 px-5 py-6"
    >
      <header>
        <Eyebrow>New App</Eyebrow>
        <div className="mt-2 h-7 w-64 animate-pulse rounded-md bg-secondary" />
        <p className="mt-2 text-sm text-muted-foreground">
          {LOADING_NOTE[phase]}
        </p>
      </header>
      <Card>
        {['Code', 'Type', 'Name', 'Where it runs'].map((label) => (
          <div
            key={label}
            className="flex items-center gap-3 border-b border-border-soft px-4 py-3 last:border-b-0"
          >
            <span className="w-[84px] shrink-0 text-xs text-muted-foreground">
              {label}
            </span>
            <span className="h-4 flex-1 animate-pulse rounded bg-secondary" />
          </div>
        ))}
      </Card>
    </div>
  );
}

/**
 * Neither read answered, so there is no draft to show.
 *
 * Every one of the three reads behind this screen is idempotent — a start
 * replays onto the draft id it was handed, and the other two are queries — so
 * the retry is free, and without it a transient failure left the operator on a
 * screen with a sentence and nothing to press.
 */
export function CreationLoadFailure({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-[760px] px-5 py-6">
      <ErrorState
        title="Failed to load creation options"
        message={message}
        onRetry={onRetry}
      />
    </div>
  );
}

export function NewApp({
  initial,
  targets: initialTargets,
  repos,
  available,
  onCreated,
}: {
  initial: CreationDraftView;
  targets: readonly TargetOptionView[];
  /** Repositories Spindrift holds a row for. */
  repos: readonly RepositoryOptionView[];
  /** Repositories GitHub currently grants this installation. */
  available: readonly GrantedRepositoryView[];
  onCreated?: (app: { readonly id: string; readonly name: string }) => void;
}) {
  const [draft, setDraft] = useState(initial.draft);
  // Placement is derived from kind, reach and auth (§3), so the options are
  // only true for the draft they were resolved against. Correcting any of the
  // three re-resolves them; leaving them stale is how a `website` ends up
  // offered the candidates for a `service`.
  const [targets, setTargets] = useState(initialTargets);
  const [serverBlockers, setServerBlockers] = useState(initial.blockers);
  const [refusal, setRefusal] = useState<Refused | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [trouble, setTrouble] = useState<DetectionTrouble | null>(null);
  // Everything the last read said about this repository, unsummarized. The
  // wizard's job is to offer it, so it is kept as it arrived: dropping the
  // scopes detection could not make sense of would leave "why not here"
  // unanswerable, and dropping the ones it could would leave the screen picking.
  const [scopes, setScopes] = useState<readonly InspectedScope[] | null>(null);
  const scopesRef = useRef<readonly InspectedScope[]>([]);
  const draftRef = useRef(initial.draft);
  const revisionRef = useRef(initial.revision);
  /** What the last write was refused with, or `null` once one has landed. */
  const unsaved = useRef<TransportFailure | null>(null);

  const candidateIds = targets
    .filter((target) => target.candidate)
    .map((target) => target.targetId);
  const detected = (scopes ?? []).filter(
    (scope) => scope.outcome === 'detected',
  );
  const unchosen = unchosenScope(
    draft,
    detected,
    draft.scopeByOperator === true,
  );
  // The sentence under Component is a statement about one directory, and the
  // draft can name another one — an edit that has not settled yet, or a
  // directory detection could make nothing of. Saying which is what keeps the
  // reason from reading as though it were about the path on screen.
  const readElsewhere =
    draft.source.kind === 'repo' &&
    draft.detection.scope !== undefined &&
    draft.detection.scope !== draft.source.subpath;
  const standing = standingTrouble(draft, trouble);
  const localBlockers = [
    ...blockersFor(draft, candidateIds),
    ...unchosen,
    ...unreadRepository(draft, standing),
  ];
  const blockers = [
    ...localBlockers,
    // Deduped on what the blocker *says*, not on its code. Both sides mint
    // `SOURCE_UNAVAILABLE` about different facts — "nothing is chosen to deploy
    // from this repository" here, "no authoritative commit ready to stage"
    // there — and matching on the code alone hid the server's sentence behind
    // the local one, so clearing the first revealed a second, unrelated
    // problem that had been there all along.
    ...serverBlockers.filter(
      (server) =>
        !localBlockers.some(
          (local) => local.code === server.code && local.title === server.title,
        ),
    ),
  ];
  const target = targets.find((option) => option.targetId === draft.targetId);
  const choices = repositoryChoices(repos, available);
  // The file the chosen directory will get, from the read that chose it.
  const spindriftFile = spindriftFileFor(
    (scopes ?? []).find(
      (scope) =>
        draft.source.kind === 'repo' && scope.scope === draft.source.subpath,
    ),
  );
  const appNameIssue = issueWith(appNameSchema, draft.appName);
  const componentNameIssue = issueWith(
    componentNameSchema,
    draft.componentName,
  );

  /**
   * Whether anything has said where the code comes from.
   *
   * The screen's one branch. Before this is true nothing below the picker can
   * be true either — a kind read from no repository, a Target resolved for that
   * kind, a URL minted from that Target — so none of it is rendered rather than
   * rendered as a claim.
   */
  const hasSource =
    draft.source.kind === 'repo'
      ? draft.source.repo !== ''
      : Boolean(draft.source.location);

  /**
   * Which row is showing its correction, and who decided.
   *
   * `null` means nobody has pressed anything, so the row holding an unmet
   * prerequisite opens itself — §3's disabled-with-reasons grammar only works
   * when the alternatives are *visible*, and "nothing can run this" is
   * unreadable while the list of places that cannot is behind a pencil. Once
   * somebody presses Edit or Done the value is theirs and a read landing never
   * moves it, which is what the three sticky refs inside every `Row` were
   * failing to do.
   */
  const [expanded, setExpanded] = useState<PlanRow | 'none' | null>(null);
  const blockersIn = (row: PlanRow) =>
    blockers.filter((blocker) => BLOCKER_ROW[blocker.code] === row);
  /**
   * Whether where-the-code-is is still the open question.
   *
   * Not every one of these is a blocker. A repository Spindrift read and could
   * build nothing in creates nothing to clear — §5's assertion path is open, so
   * naming a directory and picking a kind is a legal answer — but the list of
   * what it *did* find is the whole of why that is a readable choice, and it is
   * inside this row. A complaint about a directory with the list behind a
   * pencil is §3's grammar with the alternatives hidden.
   */
  const codeUnsettled =
    draft.source.kind === 'repo' &&
    (standing !== null || !answeredScope(draft));
  /**
   * The row that opens itself, in the order the reasons outrank each other.
   *
   * A blocker first: it is the thing between this draft and a Deploy. Then a
   * value the schema will refuse, because that message is attached to an input
   * and is unreadable anywhere else — and it is about something the person is
   * typing right now. An unanswered Code row last: it always states its
   * question on the row itself, so it is the one that can afford to wait.
   */
  const troubled: PlanRow | null =
    (['code', 'type', 'name', 'where'] as const).find(
      (row) => blockersIn(row).length > 0,
    ) ??
    (appNameIssue !== null || componentNameIssue !== null ? 'name' : null) ??
    (codeUnsettled ? 'code' : null);
  const isOpen = (row: PlanRow) =>
    expanded === null ? troubled === row : expanded === row;
  const toggle = (row: PlanRow) => () =>
    setExpanded(isOpen(row) ? 'none' : row);

  /**
   * Put the server's copy of the draft back on screen.
   *
   * The revision guard means one refused save refuses every save after it: the
   * revision the tab holds is a version that no longer exists, so the next
   * keystroke is refused for the same reason, forever. Re-reading is the whole
   * recovery — the server's draft is the truth by definition here — and what it
   * costs is whatever was typed since the other tab wrote, which is why it is
   * said out loud rather than done quietly.
   */
  const resync = async (): Promise<void> => {
    try {
      const recovered = await command('getCreationDraft', { id: initial.id });
      if (!recovered.ok) {
        unsaved.current = recovered.failure;
        setRefusal({ failure: recovered.failure });
        return;
      }
      revisionRef.current = recovered.value.revision;
      draftRef.current = recovered.value.draft;
      setDraft(recovered.value.draft);
      setServerBlockers(recovered.value.blockers);
      // Whatever the debounce is still holding was written against the version
      // that just lost, and sending it would put a document nobody is looking
      // at on the server at the revision just recovered — where it lands,
      // because the revision is all the guard checks. Dropped after the read
      // rather than before it, so an edit made while it was in flight goes too.
      writes.current?.discard();
      unsaved.current = null;
      setRefusal({
        failure: {
          code: 'STALE_EDIT',
          message:
            'Another tab saved this draft first, and its version is what is on screen now. Anything you had typed here since is gone — check the rows above before deploying.',
        },
        title: 'This draft was edited somewhere else',
      });
    } catch (cause) {
      const failure: TransportFailure = {
        code: 'INTERNAL',
        message:
          cause instanceof Error ? cause.message : 'the draft was not re-read',
      };
      unsaved.current = failure;
      setRefusal({ failure });
    }
  };

  const persist = async (next: Draft): Promise<void> => {
    try {
      const result = await command('saveCreationDraft', {
        id: initial.id,
        revision: revisionRef.current,
        draft: next,
      });
      if (result.ok) {
        revisionRef.current = result.value.revision;
        unsaved.current = null;
        setServerBlockers(result.value.blockers);
        setRefusal(null);
        return;
      }
      if (result.failure.code === 'STALE_EDIT') {
        await resync();
        return;
      }
      unsaved.current = result.failure;
      setRefusal({ failure: result.failure });
    } catch (cause) {
      const failure: TransportFailure = {
        code: 'MALFORMED_REQUEST',
        message:
          cause instanceof Error ? cause.message : 'the draft could not save',
      };
      unsaved.current = failure;
      setRefusal({ failure });
    }
  };

  const writes = useRef<DraftWrites<Draft> | null>(null);
  writes.current ??= draftWrites<Draft>({ save: persist });

  const dispatch: Dispatch<DraftAction> = (action) => {
    const previous = draftRef.current;
    const next = draftReducer(previous, action);
    draftRef.current = next;
    setDraft(next);
    // Compared rather than keyed off the action type: `entry` and `detect`
    // change the kind too, and an enumeration here would drift the first time a
    // new action moves one of the three.
    if (
      next.kind !== previous.kind ||
      next.reach !== previous.reach ||
      next.auth !== previous.auth
    ) {
      void command('listTargets', {
        kind: next.kind,
        reach: next.reach,
        auth: next.auth,
      }).then((result) => {
        // Only the newest answer counts: a slower earlier read must not
        // overwrite the options for the draft as it stands now.
        if (result.ok && draftRef.current === next)
          setTargets(result.value.options);
      });
    }
    writes.current?.edit(next);
  };

  /**
   * Read a repository and offer what is in it.
   *
   * One read of the real default branch, through the same ladder that writes
   * `spindrift.yaml`. Every directory it answered about is kept and shown, and
   * `outcomeOf` decides what — if anything — the draft may take from it.
   *
   * `scope` names one directory, which is what an edited subpath asks about —
   * §5's "named, never searched". Its answer replaces that directory's row and
   * leaves the rest of the list alone, so correcting a path does not throw away
   * the candidates beside it.
   *
   * Failing to read is not failing to select: the repo is still the source, the
   * kind is still correctable, and the sentence says which of the two happened.
   */
  const inspect = async (fullName: string, scope?: string) => {
    setDetecting(true);
    setTrouble(null);
    try {
      const result = await command(
        'inspectRepository',
        inspection(fullName, scope),
      );
      if (!result.ok) {
        // Recorded against the repository and no directory, whichever the
        // request named: what failed is the reading of the tree, and only
        // another repository — or another read — is a different answer.
        setTrouble({
          kind: 'unread',
          message: result.failure.message,
          repo: fullName,
        });
        return;
      }
      const found = result.value.scopes;
      const merged =
        scope === undefined ? found : mergeScopes(scopesRef.current, found);
      scopesRef.current = merged;
      setScopes(merged);

      const outcome = outcomeOf(draftRef.current, {
        fullName,
        scope,
        found,
        merged,
      });
      if (outcome.act === 'detect') dispatch(outcome.action);
      if (outcome.act === 'refuse')
        setTrouble({
          kind: 'unsupported',
          message: outcome.message,
          repo: fullName,
          scope,
        });
    } catch (cause) {
      setTrouble({
        kind: 'unread',
        repo: fullName,
        message:
          cause instanceof Error
            ? cause.message
            : 'the repository was not read',
      });
    } finally {
      setDetecting(false);
    }
  };

  /** Selecting a repository reads it. Nothing is written until Deploy. */
  const selectRepo = (repo: RepositoryChoice) => {
    dispatch({
      type: 'repo',
      fullName: repo.fullName,
      url: repo.cloneUrl,
      connect: repo.state === 'grant-only',
    });
    scopesRef.current = [];
    setScopes(null);
    void inspect(repo.fullName);
  };

  const chooseScope = (scope: InspectedScope) => {
    if (scope.outcome !== 'detected') return;
    dispatch({
      type: 'detect',
      scope: scope.scope,
      kind: scope.kind,
      reason: scope.reason,
      unavailable: scope.unavailable,
    });
  };

  /**
   * A settled subpath edit asks about the directory it now names.
   *
   * And is the point the typing counts as an answer — the flag rides on this
   * dispatch rather than on every keystroke, so a half-typed path no longer
   * clears the prerequisite that says nothing has been chosen yet.
   */
  const settleSubpath = () => {
    const source = draftRef.current.source;
    if (source.kind !== 'repo' || source.repo === '' || !source.subpath) return;
    dispatch({ type: 'subpath', subpath: source.subpath, settled: true });
    void inspect(source.repo, source.subpath);
  };

  // Detection runs for the repository the draft opens on, before anybody
  // presses anything. A draft claims a kind from the moment it exists, and a
  // screen that renders that claim without ever asking is the screen this
  // whole flow was supposed to replace. Reading writes nothing, so the only
  // thing it costs a draft nobody finishes is one request — and `outcomeOf`
  // is what keeps a reopened draft reading rather than re-deciding.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    const source = initial.draft.source;
    if (source.kind !== 'repo' || source.repo === '') return;
    void inspect(source.repo);
  }, []);

  // A debounce that drops the last edit when the screen goes away is a
  // debounce that loses work: navigating off within the window would leave the
  // draft one keystroke behind what was on screen. Leaving sends it.
  useEffect(
    () => () => {
      void writes.current?.flush();
    },
    [],
  );

  /** The terminal act: revalidate and create under one database lock. */
  async function start() {
    setSubmitting(true);
    try {
      const outcome = await deployDraft({
        flush: async () => {
          await writes.current?.flush();
        },
        unsaved: () => unsaved.current,
        complete: () =>
          command('completeCreationDraft', {
            id: initial.id,
            revision: revisionRef.current,
          }),
      });
      if (outcome.act === 'unsaved' || outcome.act === 'lost') {
        setRefusal({ failure: outcome.failure, title: outcome.title });
        return;
      }
      // The press is as capable of finding the stale revision as a keystroke
      // is, and it lands there whenever the last edit was already saved: the
      // flush sends nothing, so the completion is the first thing carrying the
      // revision another tab has superseded. Reported rather than recovered, it
      // is a refusal telling the operator to reload with no control that does.
      if (outcome.act === 'stale') {
        await resync();
        return;
      }
      if (outcome.act === 'refused') {
        setRefusal({ failure: outcome.failure });
        return;
      }
      setRefusal(null);
      setServerBlockers(outcome.result.draft.blockers);
      if (outcome.result.app === null) return;
      // Said before the navigation, because after it this screen is gone and
      // the pull request is the one thing creation did that is not on the App
      // it navigates to. §15 makes merging it the act that connects the
      // repository, so an App created with an unmentioned pull request is an
      // App whose next Build runs on the wrong repository's minutes.
      reportConfigPullRequest(outcome.result.app);
      onCreated?.({
        id: outcome.result.app.appId,
        name: outcome.result.app.name,
      });
    } finally {
      // Whatever happened, the button stops saying it is creating something.
      setSubmitting(false);
    }
  }

  const header = (title: string, note: string) => (
    <header>
      <Eyebrow>New App</Eyebrow>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">{note}</p>
    </header>
  );

  const sourceControls = (
    <SourceControls
      draft={draft}
      dispatch={dispatch}
      repos={choices}
      scopes={scopes}
      onSelectRepo={selectRepo}
      onChooseScope={chooseScope}
      onSettleSubpath={settleSubpath}
    />
  );

  // Until something says where the code is, the picker *is* the page. Every
  // row below it would be a statement about a repository nobody has chosen —
  // which is exactly what this screen used to render, because the draft was
  // born pointing at whichever repository sorted first.
  if (!hasSource) {
    return (
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5 px-5 py-6">
        {/*
          Both tiles are on this page, so the header names neither. It said
          "Import a repository" over an Upload tile, which is the page arguing
          with the control directly beneath it.
        */}
        {header(
          'Import your code',
          'Say where the code comes from. Nothing is connected or written until you press Deploy.',
        )}
        <Card>
          <div className="px-4 py-4">{sourceControls}</div>
        </Card>
        {refusal ? (
          <Refusal failure={refusal.failure} title={refusal.title} />
        ) : null}
      </div>
    );
  }

  const title =
    draft.source.kind !== 'repo'
      ? 'Deploy an upload'
      : `Deploy from ${draft.source.repo}`;

  // The read that follows choosing a repository, with nothing mounted under it.
  // A card of rows drawn from a draft nothing has read yet is a card that
  // rewrites itself a second later, and the reader loses their place in it.
  //
  // `answeredScope` is what keeps a reopened draft out of here: it has been
  // answered, `outcomeOf` will apply nothing, and flashing a reading state at
  // somebody returning to a finished draft says a question is being asked.
  if (detecting && scopes === null && !answeredScope(draft)) {
    return (
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5 px-5 py-6">
        {header(title, 'Reading the repository to work out what is in it.')}
        <Card>
          <p className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            Reading {draft.source.kind === 'repo' ? draft.source.repo : ''}…
          </p>
        </Card>
      </div>
    );
  }

  const placement =
    target === undefined
      ? 'nowhere yet'
      : `${target.vessel} · ${ADAPTER_LABEL[target.adapter] ?? target.adapter} — ${REACH_LABEL[draft.reach]}${
          draft.reach === 'none' ? '' : `, ${AUTH_LABEL[draft.auth]}`
        }`;

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5 px-5 py-6">
      {header(
        title,
        draft.source.kind === 'repo'
          ? 'Spindrift filled this in from your repository. Change anything that is wrong, then deploy.'
          : 'Nothing has read your archive, so check the type and the name below, then deploy.',
      )}

      {/*
        Dependency order, top to bottom. Placement is *derived* from kind, reach
        and auth (§3) — the `listTargets` refetch in `dispatch` is that
        derivation, firing whenever one of the three moves — so `Where it runs`
        is last and never asks anybody to accept a consequence before its cause.

        Name is third. It is derived from the repository, so asking for it first
        was asking somebody to name a thing before saying what it is.
      */}
      <Card>
        <Row
          label="Code"
          value={
            draft.source.kind !== 'repo'
              ? draft.source.filename
              : `${draft.source.repo} · ${draft.source.subpath}`
          }
          tone={
            detecting ? (
              <Badge tone="idle">
                <Loader2 aria-hidden="true" className="size-3 animate-spin" />
                reading
              </Badge>
            ) : null
          }
          why={
            standing?.message ??
            (readElsewhere && draft.source.kind === 'repo'
              ? `${draft.detection.reason} — read in ${draft.detection.scope}, and the root directory now names ${draft.source.subpath}.`
              : draft.source.kind === 'archive'
                ? 'Nothing has looked inside an archive.'
                : draft.detection.reason)
          }
          open={isOpen('code')}
          onToggle={toggle('code')}
          blockers={blockersIn('code')}
        >
          {sourceControls}
        </Row>

        <Row
          label="Type"
          value={KIND_LABEL[draft.kind]}
          why={
            draft.kind !== draft.detection.kind
              ? // The badge says a correction happened; the reason underneath
                // was still detection's, so the row read `Website` over "the
                // default is a long-running service" and flatly contradicted
                // the value beside it.
                `You chose ${KIND_LABEL[draft.kind]}. Detection read ${KIND_LABEL[draft.detection.kind]} — ${draft.detection.reason}`
              : draft.detection.reason
          }
          tone={
            draft.kind === draft.detection.kind ? null : (
              <Badge tone="warning">corrected</Badge>
            )
          }
          open={isOpen('type')}
          onToggle={toggle('type')}
          blockers={blockersIn('type')}
        >
          <div className="grid gap-2 sm:grid-cols-3">
            {KINDS.map((kind) => {
              const reason = draft.detection.unavailable[kind];
              return (
                <Choice
                  key={kind}
                  selected={draft.kind === kind}
                  disabled={reason !== undefined}
                  title={KIND_LABEL[kind]}
                  note={reason ?? KIND_NOTE[kind]}
                  onClick={() => dispatch({ type: 'kind', kind })}
                />
              );
            })}
          </div>
        </Row>

        <Row
          label="Name"
          value={draft.appName}
          why={
            // Stated rather than assumed, the way the Code and Type rows above
            // state theirs. A name the operator typed is their answer and a
            // draft that has never seen a repository derived nothing, so one
            // sentence claiming a derivation was false on both.
            draft.appNameByOperator === true
              ? 'You named it. It becomes part of the address.'
              : draft.source.kind === 'repo'
                ? 'Named after the repository. It becomes part of the address.'
                : 'An upload carries no name, so this is the default. It becomes part of the address.'
          }
          open={isOpen('name')}
          onToggle={toggle('name')}
          blockers={blockersIn('name')}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              name="appName"
              label="App name"
              value={draft.appName}
              onChange={(event) =>
                dispatch({
                  type: 'field',
                  field: 'appName',
                  value: event.target.value,
                })
              }
              issue={appNameIssue}
              hint="Lowercase letters, numbers and hyphens. It becomes part of the address."
            />
            <Field
              name="componentName"
              label="Component name"
              value={draft.componentName}
              onChange={(event) =>
                dispatch({
                  type: 'field',
                  field: 'componentName',
                  value: event.target.value,
                })
              }
              issue={componentNameIssue}
              hint="web, worker, api — the one workload this App starts with."
            />
          </div>
        </Row>

        {/*
          One row, five facts. Reach, Auth, Target, URL and Vessel each had a
          row of their own, which asked a reader to hold five platform nouns to
          answer one question: where does this run and who can reach it. The
          sentence is the answer; the controls behind the Edit are unchanged,
          in the order the derivation runs — the two that decide which Targets
          are candidates, then the Targets, then the vessel that follows.
        */}
        <Row
          label="Where it runs"
          value={placement}
          tone={
            target === undefined || target.candidate ? null : (
              <Badge tone="destructive">can't run this</Badge>
            )
          }
          why={
            target === undefined
              ? 'Nowhere is chosen to run it yet.'
              : target.candidate
                ? // The Target mints a hostname whatever the reach is, and at
                  // `reach: none` nothing routes to it — so printing it under a
                  // row whose own value reads `no address` contradicted the
                  // line above it. The draft decides whether there is an
                  // address; the Target only decides what it would be.
                  draft.reach === 'none'
                  ? 'Nothing routes to it, so it has no address.'
                  : // §9: `null` is not "pending" — it is `cloudrun`/`static`
                    // reporting their own address back after deploy, which this
                    // step cannot show early because nothing has deployed yet.
                    (target.canonical ??
                    'Spindrift assigns the address on the first deploy.')
                : // The sentences the picker below prints, not the bare
                  // Exclusion codes they translate.
                  target.reasons
                    .map((reason, index) => target.detail[index] ?? reason)
                    .join('; ')
          }
          open={isOpen('where')}
          onToggle={toggle('where')}
          blockers={blockersIn('where')}
        >
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Eyebrow>
                Who can reach it
                {draft.reach === OPENING_REACH
                  ? ' \u00b7 still the default'
                  : ''}
              </Eyebrow>
              <div className="grid gap-2 sm:grid-cols-3">
                {REACHES.map((reach) => (
                  <Choice
                    key={reach}
                    selected={draft.reach === reach}
                    title={REACH_LABEL[reach]}
                    note={REACH_NOTE[reach]}
                    onClick={() => dispatch({ type: 'reach', reach })}
                  />
                ))}
              </div>
            </div>

            {/*
              Offered separately because it is a separate fact, and hidden at
              `reach: none` because there is no route to put a filter on — the
              same refusal validation makes, stated by not asking.
            */}
            {draft.reach !== 'none' && (
              <div className="flex flex-col gap-2">
                <Eyebrow>
                  Sign-in
                  {draft.auth === OPENING_AUTH
                    ? ' \u00b7 still the default'
                    : ''}
                </Eyebrow>
                <div className="grid gap-2 sm:grid-cols-2">
                  {AUTHS.map((auth) => (
                    <Choice
                      key={auth}
                      selected={draft.auth === auth}
                      title={AUTH_LABEL[auth]}
                      note={AUTH_NOTE[auth]}
                      onClick={() => dispatch({ type: 'auth', auth })}
                    />
                  ))}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Eyebrow>Ranked by your admin</Eyebrow>
              {targets.map((option) => (
                <Choice
                  key={option.targetId}
                  selected={draft.targetId === option.targetId}
                  disabled={!option.candidate}
                  onClick={() =>
                    dispatch({ type: 'target', targetId: option.targetId })
                  }
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">
                      {option.vessel}
                    </span>
                    <Badge tone="idle">
                      {ADAPTER_LABEL[option.adapter] ?? option.adapter}
                    </Badge>
                    {option.candidate && option.artifactType ? (
                      <Badge tone="accent">{option.artifactType}</Badge>
                    ) : null}
                    <span className="ml-auto font-mono text-xs text-muted-foreground">
                      rank {option.rank}
                    </span>
                  </div>
                  {option.candidate ? (
                    <span
                      className={
                        option.canonical === null
                          ? 'text-xs text-subtle'
                          : 'font-mono text-xs text-muted-foreground'
                      }
                    >
                      {/* §9: `null` means this adapter names its own workloads
                          — say so rather than showing a suffix core will never
                          mint. */}
                      {option.canonical ?? 'assigns its own address'}
                    </span>
                  ) : (
                    <ul className="flex flex-col gap-0.5">
                      {option.reasons.map((reason, index) => (
                        <li key={reason} className="text-xs text-destructive">
                          <span className="font-mono font-semibold">
                            {reason}
                          </span>
                          {option.detail[index]
                            ? ` — ${option.detail[index]}`
                            : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                </Choice>
              ))}
            </div>

            <VesselNote
              name={draft.vessel.name}
              note={draft.vessel.note}
              ready={draft.vessel.ready}
            />
          </div>
        </Row>
      </Card>

      {refusal ? (
        <Refusal failure={refusal.failure} title={refusal.title} />
      ) : null}

      {/*
        Deploy is two acts, and only one of them is visible above. It creates
        the App — and, for a repository Spindrift holds no row for, it commits
        this file to that repository in the configuration pull request §15 makes
        authoritative. Agreeing to the first is not agreeing to the second
        unless the second is on screen, which is why the title is the consent
        sentence rather than a description of a file.
      */}
      {spindriftFile !== null && draft.source.kind === 'repo' ? (
        <Declaration
          title={
            draft.source.connect === true
              ? `Deploy also connects ${draft.source.repo} and opens a pull request`
              : "What this App's spindrift.yaml would say"
          }
          label={
            draft.source.subpath === '.'
              ? 'spindrift.yaml'
              : `${draft.source.subpath}/spindrift.yaml`
          }
          note={
            <>
              Committed to{' '}
              <span className="font-mono">{draft.source.repo}</span> on a
              configuration pull request, alongside one workflow caller.
              Spindrift adopts it only once that pull request merges into the
              default branch.
            </>
          }
          caveat={
            draft.source.connect === true
              ? undefined
              : `${draft.source.repo} is already connected, so Deploy commits nothing.`
          }
          text={spindriftFile}
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {/*
          One gate and one alternate label. `saving` was an arm that only made
          the button flicker through a burst of typing — `deployDraft` flushes
          the debounce and refuses on a write that never landed, which is a
          better answer than a button that was briefly not pressable. `detecting`
          stays, because a press mid-read would land on a directory the read is
          about to refuse, but it loses its label: the Code row's `reading`
          badge already says which arm it is.
        */}
        <Button
          disabled={blockers.length > 0 || submitting || detecting}
          onClick={start}
        >
          <Rocket aria-hidden="true" />
          {submitting ? 'Creating…' : 'Deploy'}
        </Button>
        <p className="text-xs text-muted-foreground">
          {blockers.length > 0
            ? `${blockers.length} thing${blockers.length === 1 ? '' : 's'} to fix above. Nothing has been created; this draft is kept.`
            : 'Creates the App, locks where it runs, and starts the first build.'}
        </p>
      </div>
    </div>
  );
}

interface UploadValue {
  readonly digest: string;
  readonly location: string;
  readonly filename: string;
  readonly size: number;
}

/**
 * Archive upload, with byte progress.
 *
 * `fetch` has no cross-browser way to report how much of a request body has
 * gone out — the upload side of the streams `ReadableStream` request bodies
 * would need is not the broadly-supported half. `XMLHttpRequest.upload` has
 * carried this exact event since it was introduced, so this is the one
 * remaining reason the screen reaches for it instead of `client.ts`'s `fetch`
 * wrapper the rest of the app uses.
 */
function uploadArchive(
  file: File,
  onProgress: (percent: number) => void,
): Promise<ClientResult<UploadValue>> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/internal/upload');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.onload = () => {
      try {
        resolve(JSON.parse(xhr.responseText) as ClientResult<UploadValue>);
      } catch {
        reject(new Error('Upload response was not valid JSON'));
      }
    };
    const formData = new FormData();
    formData.append('file', file);
    xhr.send(formData);
  });
}

/**
 * Where the code comes from — the one thing on this screen that is genuinely
 * a question.
 *
 * Not a row. It is the whole page until it is answered, and the Code row's
 * correction after that, so it renders controls and nothing about how they are
 * framed. Choosing a repository detects immediately rather than waiting for a
 * Continue: everything downstream is wrong until it has.
 */
function SourceControls({
  draft,
  dispatch,
  repos,
  scopes,
  onSelectRepo,
  onChooseScope,
  onSettleSubpath,
}: {
  draft: Draft;
  dispatch: Dispatch<DraftAction>;
  repos: readonly RepositoryChoice[];
  /** What the last read said, or `null` before anything has been read. */
  scopes: readonly InspectedScope[] | null;
  onSelectRepo: (repo: RepositoryChoice) => void;
  onChooseScope: (scope: InspectedScope) => void;
  onSettleSubpath: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setUploadError(null);
    setUploadPercent(0);
    try {
      // No bucket named: which bucket sources stage to is installation
      // configuration and lives on the Storage screen.
      const res = await uploadArchive(file, setUploadPercent);
      if (res.ok) {
        dispatch({
          type: 'archive',
          filename: res.value.filename,
          digest: res.value.digest,
          location: res.value.location,
        });
      } else if (res.failure.code === 'UNAUTHENTICATED') {
        // The 24h session expired mid-upload. This row has nothing sensible
        // to render for that beyond the raw refusal — `App` (`app.tsx`) does,
        // by re-gating to sign-in.
        reportSessionExpired();
      } else {
        setUploadError(res.failure.message || 'Archive upload failed');
      }
    } catch (err: unknown) {
      setUploadError(
        err instanceof Error ? err.message : 'Network error during upload',
      );
    } finally {
      setUploading(false);
      setUploadPercent(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/*
          Selected by what the source *is*, not by `draft.entry`. A stored draft
          may carry `service`, `website` or `discover` — values the enum keeps
          and this list no longer offers — and matching on the id would leave
          both tiles unselected on a draft that plainly has a repository in it.
        */}
      <div className="grid gap-2 sm:grid-cols-2">
        {ENTRIES.map((entry) => (
          <Choice
            key={entry.id}
            selected={
              draft.source.kind === (entry.id === 'upload' ? 'archive' : 'repo')
            }
            title={entry.label}
            note={entry.note}
            onClick={() => dispatch({ type: 'entry', entry: entry.id })}
          />
        ))}
      </div>

      {draft.source.kind === 'repo' ? (
        <div className="flex flex-col gap-3">
          <RepoPicker
            repos={repos}
            selected={draft.source.repo === '' ? null : draft.source.repo}
            onSelect={onSelectRepo}
          />
          {/*
              Nothing to choose a directory *in* until a repository is chosen.
              Offering "Root directory" over an empty picker asks for a path in
              a tree that does not exist yet, which is the same mistake as the
              rows that used to sit under an unchosen repo.
            */}
          {draft.source.repo === '' ? null : (
            <>
              <ScopeChooser
                subpath={draft.source.subpath}
                scopes={scopes}
                onChoose={onChooseScope}
              />
              <Field
                name="subpath"
                label="Root directory"
                value={draft.source.subpath}
                onChange={(event) =>
                  dispatch({ type: 'subpath', subpath: event.target.value })
                }
                // Settled rather than per-keystroke: the reason on screen is a
                // statement about one directory, and re-reading `apps/w` on the
                // way to `apps/web` would describe a directory nobody named.
                onBlur={onSettleSubpath}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onSettleSubpath();
                }}
                hint="Spindrift reads the directory you name and no others. Press Enter to read it."
              />
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <label className="flex cursor-pointer flex-col items-center justify-center rounded-md border-2 border-dashed border-border p-4 transition-colors hover:border-primary">
            <span className="text-sm font-medium text-foreground">
              {uploading
                ? `Uploading archive… ${uploadPercent ?? 0}%`
                : 'Choose or drop a zip/tar archive'}
            </span>
            <span className="mt-0.5 text-xs text-muted-foreground">
              Accepts .zip, .tar.gz, .tgz
            </span>
            {uploading ? (
              <div className="mt-2 h-1 w-full max-w-56 overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-150 ease-out"
                  style={{ width: `${uploadPercent ?? 0}%` }}
                />
              </div>
            ) : null}
            <input
              type="file"
              // Exactly what `storage/archive-format.ts` sniffs — gzip magic
              // or ZIP magic. A plain `.tar` in this list is an invitation
              // the boundary answers with `UNKNOWN_FORMAT`, which makes the
              // chooser the thing that was wrong.
              accept=".zip,.tar.gz,.tgz"
              disabled={uploading}
              onChange={handleFileChange}
              className="hidden"
            />
          </label>
          {draft.source.location ? (
            <p className="font-mono text-[11px] text-success">
              staged: {draft.source.location}
            </p>
          ) : null}
          {uploadError ? (
            <p className="text-xs text-destructive">{uploadError}</p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Nothing has looked inside an archive, so pick the type yourself.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * Every directory the repository was read for, as one control to choose from.
 *
 * §5 says discovery "proposes a list of candidate directories for a human to
 * choose from", and this is that list rather than a summary of it. A directory
 * detection knows how to build is selectable and wears the kind and the
 * sentence behind it; one it does not is here too, disabled, wearing what it
 * found instead — §3's grammar, which only works if the alternatives stay
 * readable.
 *
 * **Bounded rows, not a tile grid and not a `<select>`.** A grid of tiles put a
 * monorepo's twenty directories between Source and every row below it. A
 * `<select>` bounded that, but a native option is one line of plain text, so
 * the directory, its kind and the sentence behind it were run together into a
 * single very long line — and the one thing an operator is scanning for, the
 * path, was the shortest part of it. Rows in a scroller of fixed height keep
 * §3's grammar legible and keep the section the same size whether the
 * repository holds two directories or forty.
 *
 * An empty list means nothing has been read yet, which is a different thing
 * from a repository with nothing in it.
 */
function ScopeChooser({
  subpath,
  scopes,
  onChoose,
}: {
  subpath: string;
  scopes: readonly InspectedScope[] | null;
  onChoose: (scope: InspectedScope) => void;
}) {
  const [filter, setFilter] = useState('');
  if (scopes === null || scopes.length === 0) return null;

  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? scopes.filter((scope) => scope.scope.toLowerCase().includes(needle))
    : scopes;

  return (
    <div className="flex flex-col gap-2">
      <Eyebrow>Directories in this repo · {scopes.length}</Eyebrow>
      <div className="relative">
        <Search
          aria-hidden="true"
          className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="text"
          aria-label="Filter directories"
          placeholder="Filter directories…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className={cn(
            'w-full rounded-md border border-border bg-card py-2 pl-9 pr-3 font-mono text-sm',
            'placeholder:text-muted-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
          )}
        />
      </div>
      <div
        role="listbox"
        aria-label="Directories in this repo"
        className="flex max-h-[240px] flex-col gap-1 overflow-y-auto rounded-md border border-border bg-card p-1.5"
      >
        {shown.length === 0 ? (
          <p className="px-2 py-4 text-center text-sm text-muted-foreground">
            No directory read from this repository matches that filter.
          </p>
        ) : (
          shown.map((scope) => {
            const detected = scope.outcome === 'detected';
            // The directory the draft names is what it is deploying, whatever
            // detection made of it — story 32 keeps that escape hatch open and
            // Deploy is not blocked on it. So it reads as the row in force
            // rather than as the one row that cannot be chosen.
            const current = scope.scope === subpath;
            return (
              <button
                key={scope.scope}
                type="button"
                role="option"
                aria-selected={current}
                disabled={!detected && !current}
                onClick={() => onChoose(scope)}
                className={cn(
                  'flex flex-col gap-0.5 rounded-md px-3 py-2 text-left transition-colors',
                  current
                    ? 'border border-primary bg-accent'
                    : 'border border-transparent hover:bg-secondary',
                  !detected && !current && 'cursor-not-allowed opacity-60',
                )}
              >
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-sm">
                    {scope.scope}
                  </span>
                  <Badge tone={detected ? 'accent' : 'idle'}>
                    {detected ? scope.kind : 'cannot build'}
                  </Badge>
                </span>
                <span className="text-xs text-muted-foreground">
                  {detected ? scope.reason : scope.detail}
                </span>
              </button>
            );
          })
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Choosing one reads it and names the workload after it. Nothing is picked
        for you when there is more than one.
      </p>
    </div>
  );
}

/**
 * What the server said when it would not do it.
 *
 * The code is shown alongside the sentence because it is a closed vocabulary
 * and therefore searchable — the same reason §6 keeps its eight failure reasons
 * rather than writing friendlier prose.
 *
 * `title` is what the operator was doing when it arrived. A refusal from a save
 * nobody watched, still on screen when Deploy is pressed, otherwise reads as
 * the answer to the press — and the two want different sentences.
 */
function Refusal({
  failure,
  title,
}: {
  failure: TransportFailure;
  title?: string;
}) {
  return (
    <div className="rounded-md border border-destructive bg-destructive-soft px-3 py-2.5">
      {title ? (
        <p className="text-sm font-semibold text-destructive">{title}</p>
      ) : null}
      <p className="font-mono text-xs font-semibold text-destructive">
        {failure.code}
      </p>
      <p className="mt-0.5 text-sm text-subtle">{failure.message}</p>
      {failure.issues?.length ? (
        <ul className="mt-1.5 flex flex-col gap-0.5">
          {failure.issues.map((issue) => (
            <li key={issue.path} className="font-mono text-xs text-subtle">
              {issue.path}: {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The creation screen — the two reads the flow opens with, and the draft they
 * resolve.
 *
 * **The draft first, the options after it.** Placement is derived from what is
 * being created (§3), so asking which Targets will take this workload before
 * the draft exists is asking about a different workload. Repositories load
 * alongside the Targets rather than behind them — that read depends on
 * nothing.
 *
 * **The path this screen rewrites is not navigation.** Starting a draft names
 * it, the URL becomes `/apps/new/<id>`, and that arrives back through the
 * router as a changed prop. Reloading for it would re-run both reads and throw
 * away everything typed since, which is the whole of what remounting on the id
 * used to cost — so the screen keeps its own record of which draft is loaded
 * and compares.
 *
 * Not a `useRead`: the two reads are sequential rather than parallel, the
 * second is composed from the first's answer, and the load has two phases the
 * skeleton names. One cadence over four commands is the wrong shape for all
 * three.
 */
export function NewAppScreen({
  draftId,
  onNavigate,
}: {
  draftId: string | null;
  onNavigate: (path: string) => void;
}) {
  const [state, setState] = useState<
    | { type: 'loading'; phase: CreationLoad }
    | { type: 'error'; message: string }
    | {
        type: 'success';
        targetOptions: readonly TargetOptionView[];
        repoOptions: readonly RepositoryOptionView[];
        repoGrant: readonly GrantedRepositoryView[];
        draft: CreationDraftView;
      }
  >({ type: 'loading', phase: 'draft' });
  const [attempt, setAttempt] = useState(0);
  // React Strict Mode replays effects in development. Supplying the identity
  // makes both starts the same authenticated act instead of leaving an orphan.
  const startId = useRef(crypto.randomUUID());
  /** The draft on screen, so this screen's own URL rewrite is not navigation. */
  const loaded = useRef<string | null>(null);

  useEffect(() => {
    if (draftId !== null && draftId === loaded.current) return;
    if (draftId === null && loaded.current !== null) {
      // `New App` pressed while a draft is open: a genuinely new one needs an
      // identity of its own, or `startCreationDraft` idempotently answers with
      // the draft already on screen.
      startId.current = crypto.randomUUID();
      loaded.current = null;
    }
    let live = true;
    setState({ type: 'loading', phase: 'draft' });
    const draftRequest =
      draftId === null
        ? command('startCreationDraft', { id: startId.current })
        : command('getCreationDraft', { id: draftId });
    (async () => {
      const draftRes = await draftRequest;
      if (!live) return;
      if (!draftRes.ok) {
        setState({ type: 'error', message: draftRes.failure.message });
        return;
      }
      setState({ type: 'loading', phase: 'options' });
      const { kind, reach, auth } = draftRes.value.draft;
      const [targetRes, repoRes] = await Promise.all([
        command('listTargets', { kind, reach, auth }),
        command('listRepositories', {}),
      ]);
      if (!live) return;
      if (!targetRes.ok) {
        setState({ type: 'error', message: targetRes.failure.message });
        return;
      }
      if (!repoRes.ok) {
        setState({ type: 'error', message: repoRes.failure.message });
        return;
      }
      loaded.current = draftRes.value.id;
      setState({
        type: 'success',
        targetOptions: targetRes.value.options,
        repoOptions: repoRes.value.options,
        repoGrant: repoRes.value.available,
        draft: draftRes.value,
      });
      if (draftId === null) {
        onNavigate(`/apps/new/${draftRes.value.id}`);
      }
    })().catch((e: unknown) => {
      if (!live) return;
      setState({
        type: 'error',
        message: e instanceof Error ? e.message : 'Server failure',
      });
    });
    return () => {
      live = false;
    };
  }, [draftId, onNavigate, attempt]);

  if (state.type === 'loading') return <CreationSkeleton phase={state.phase} />;

  if (state.type === 'error') {
    return (
      <CreationLoadFailure
        message={state.message}
        onRetry={() => setAttempt((value) => value + 1)}
      />
    );
  }

  return (
    <NewApp
      key={state.draft.id}
      initial={state.draft}
      targets={state.targetOptions}
      repos={state.repoOptions}
      available={state.repoGrant}
      onCreated={(app) => onNavigate(`/apps/${app.id}`)}
    />
  );
}
