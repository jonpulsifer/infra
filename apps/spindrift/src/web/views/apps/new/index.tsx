/**
 * Deploying a new App: one screen, already answered.
 *
 * §18 named the creation flow Source → Component → Place → Configure → Review.
 * The rail went away — stories 31 and 32 say what the sequence was *for*,
 * "defaults carrying every step" and "corrections hidden behind progressive
 * disclosure", and five screens with a Continue button under each turned out to
 * be the rendering that made every default look like a question. Four Continues
 * to accept four answers nobody disagreed with is not a short happy path; it is
 * a long one with the disagreement removed.
 *
 * So: name it, pick a source, read what it resolved to, press Deploy. Every row
 * states the answer **and why it is the answer**, and every row that can be
 * corrected opens the correction in place, without losing sight of the rows
 * that choice decides.
 *
 * **The rows are in dependency order**, which is not the order §18 listed them
 * in and is the order the data actually has. Placement is derived from kind,
 * reach and auth (§3) — the `listTargets` refetch below *is* that derivation —
 * so Target and the URL it mints come after the three answers that decide which
 * Targets are candidates at all, not before them. Name leads because it is the
 * only row that is nothing else's consequence.
 *
 * The reason this is honest now and would not have been before is
 * `inspectRepository`. The draft has always carried a `detection` block and
 * nothing could ever fill it, so every draft opened claiming to be a service
 * "until detection says otherwise" and detection never said. Choosing a
 * repository here runs the real §5 ladder over the real default branch, and
 * the kind, the scope, the build frontend and the ruled-out kinds are what it
 * found.
 */
import { AlertTriangle, Loader2, Rocket, Search } from 'lucide-react';
import { type Dispatch, useEffect, useRef, useState } from 'react';
import type { ZodType } from 'zod';
import type {
  GrantedRepositoryView,
  RepositoryOptionView,
  TargetOptionView,
} from '../../../../commands/views.ts';
import type {
  Blocker,
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
  Advanced,
  AUTH_NOTE,
  AUTHS,
  Choice,
  KIND_NOTE,
  KINDS,
  REACH_NOTE,
  REACHES,
  Row,
  TargetHealth,
  VesselRow,
} from './summary.tsx';
import { type DraftWrites, draftWrites } from './writes.ts';

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
      remediation: `Detection found ${detected.length} directories it knows how to build. Pick one under Source, or name another yourself.`,
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
      remediation: `Until it can be read, everything below Source is the draft's opening claim rather than anything found in the repository.`,
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
        {['Source', 'Component', 'Target', 'URL', 'Reach', 'Vessel'].map(
          (label) => (
            <div
              key={label}
              className="flex items-center gap-3 border-b border-border-soft px-4 py-3 last:border-b-0"
            >
              <span className="w-[84px] shrink-0 text-xs text-muted-foreground">
                {label}
              </span>
              <span className="h-4 flex-1 animate-pulse rounded bg-secondary" />
            </div>
          ),
        )}
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
  const [saving, setSaving] = useState(false);
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
  writes.current ??= draftWrites<Draft>({
    save: persist,
    onWriting: setSaving,
  });

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

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5 px-5 py-6">
      <header>
        <Eyebrow>New App</Eyebrow>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          {draft.source.kind !== 'repo'
            ? 'Deploy an upload'
            : draft.source.repo === ''
              ? 'Deploy from a repository'
              : `Deploy from ${draft.source.repo}`}
        </h1>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">
          Everything below already has an answer. Read down, correct what is
          wrong, and start the first Build.
        </p>
      </header>

      {/*
        The order is the dependency order, top to bottom, and it did not used
        to be. Placement is *derived* from kind, reach and auth (§3) — the
        `listTargets` refetch in `dispatch` is that derivation, firing whenever
        one of the three moves — so a reader met the Target, and the URL it
        mints, several rows before the three answers that decide which Targets
        are even candidates. Reading down now never asks anybody to accept a
        consequence before its cause.

        Name is first because it is the only row that is nothing's consequence.
      */}
      <Card>
        <Row
          label="Name"
          // A name the schema will refuse is an answer nobody has given yet,
          // so the row that holds it opens rather than hiding the field the
          // message is attached to behind a pencil.
          unsettled={appNameIssue !== null || componentNameIssue !== null}
          value={`${draft.appName} · ${draft.componentName}`}
          why="The App is the product; the Component is the one workload this creates inside it."
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
              hint="Lowercase DNS label — it appears in the canonical hostname."
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
            />
          </div>
        </Row>

        <SourceRow
          draft={draft}
          dispatch={dispatch}
          repos={choices}
          scopes={scopes}
          detecting={detecting}
          trouble={standing}
          unchosen={unchosen.length > 0}
          onSelectRepo={selectRepo}
          onChooseScope={chooseScope}
          onSettleSubpath={settleSubpath}
        />

        <Row
          label="Component"
          unsettled={standing !== null || unchosen.length > 0 || readElsewhere}
          value={draft.kind}
          why={
            readElsewhere && draft.source.kind === 'repo'
              ? `${draft.detection.reason} — read in ${draft.detection.scope}, and the root directory now names ${draft.source.subpath}.`
              : draft.kind !== draft.detection.kind
                ? // The badge says a correction happened; the reason underneath
                  // was still detection's, so the row read `web · website` over
                  // "the default is a long-running service" and flatly
                  // contradicted the value beside it.
                  `You chose ${draft.kind}. Detection read ${draft.detection.kind} — ${draft.detection.reason}`
                : draft.detection.reason
          }
          tone={
            draft.kind === draft.detection.kind ? null : (
              <Badge tone="warning">corrected</Badge>
            )
          }
        >
          <div className="grid gap-2 sm:grid-cols-3">
            {KINDS.map((kind) => {
              const reason = draft.detection.unavailable[kind];
              return (
                <Choice
                  key={kind}
                  selected={draft.kind === kind}
                  disabled={reason !== undefined}
                  title={kind}
                  note={reason ?? KIND_NOTE[kind]}
                  onClick={() => dispatch({ type: 'kind', kind })}
                />
              );
            })}
          </div>
        </Row>

        {/*
          `Row`'s whole claim is that a stated reason is what separates a
          default from something somebody typed — and these two notes are
          dictionary definitions of the value, identical whether the operator
          chose it or the draft was born with it. Saying which is the reason.
        */}
        <Row
          label="Reach"
          value={draft.reach}
          why={`${draft.reach === OPENING_REACH ? 'Default — ' : ''}${REACH_NOTE[draft.reach]}`}
        >
          <div className="grid gap-2 sm:grid-cols-3">
            {REACHES.map((reach) => (
              <Choice
                key={reach}
                selected={draft.reach === reach}
                title={reach}
                note={REACH_NOTE[reach]}
                onClick={() => dispatch({ type: 'reach', reach })}
              />
            ))}
          </div>
        </Row>

        {/*
          Offered separately because it is a separate fact, and hidden at
          `reach: none` because there is no route to put a filter on — the same
          refusal validation makes, stated by not asking.
        */}
        {draft.reach !== 'none' && (
          <Row
            label="Auth"
            value={draft.auth}
            why={`${draft.auth === OPENING_AUTH ? 'Default — ' : ''}${AUTH_NOTE[draft.auth]}`}
          >
            <div className="grid gap-2 sm:grid-cols-2">
              {AUTHS.map((auth) => (
                <Choice
                  key={auth}
                  selected={draft.auth === auth}
                  title={auth}
                  note={AUTH_NOTE[auth]}
                  onClick={() => dispatch({ type: 'auth', auth })}
                />
              ))}
            </div>
          </Row>
        )}

        <Row
          label="Target"
          unsettled={target === undefined || !target.candidate}
          value={
            target === undefined ? 'none' : `${target.vessel}/${target.adapter}`
          }
          tone={
            target === undefined ? null : (
              <TargetHealth healthy={target.candidate} />
            )
          }
          why={
            target === undefined
              ? 'No Target is selected.'
              : target.candidate
                ? `${target.adapter} · ${target.artifactType ?? 'no artifact shape'} · rank ${target.rank}`
                : // The sentences the picker below prints, not the bare
                  // Exclusion codes they translate.
                  target.reasons
                    .map((reason, index) => target.detail[index] ?? reason)
                    .join('; ')
          }
        >
          <div className="flex flex-col gap-2">
            <Eyebrow>Targets, in admin rank order</Eyebrow>
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
                  <span className="text-sm font-semibold">{option.vessel}</span>
                  <Badge tone="idle">{option.adapter}</Badge>
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
                    {option.canonical ?? 'platform names its own'}
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
        </Row>

        <Row
          label="URL"
          value={
            target === undefined
              ? 'pending a Target'
              : // §9: `null` is not "pending" — it is `cloudrun`/`static`
                // reporting their own address back after deploy, which this
                // step cannot show early because nothing has deployed yet.
                (target.canonical ?? 'platform names its own')
          }
        />

        <VesselRow
          name={draft.vessel.name}
          note={draft.vessel.note}
          ready={draft.vessel.ready}
        />

        <Advanced
          title={`Config (${draft.config.length} ${draft.config.length === 1 ? 'key' : 'keys'})`}
        >
          {draft.config.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No configuration keys yet. A config change produces a new Deploy.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {draft.config.map((key) => (
                <div
                  key={key.name}
                  className="flex items-center gap-3 rounded-md border border-border px-3 py-2"
                >
                  <span className="font-mono text-sm">{key.name}</span>
                  <Badge
                    tone={key.supplied ? 'success' : 'warning'}
                    className="ml-auto"
                  >
                    {key.supplied ? 'supplied' : 'needs a value'}
                  </Badge>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                Values are write-only. Spindrift stores one secret per variable
                and never reads one back — including here, which is why a key
                left empty cannot be filled in from this screen later.
              </p>
            </div>
          )}
        </Advanced>
      </Card>

      {blockers.length > 0 ? (
        <div className="flex flex-col gap-2">
          {blockers.map((blocker) => (
            <div
              key={blocker.code}
              className="flex items-start gap-2.5 rounded-md border border-destructive bg-destructive-soft px-3 py-2.5"
            >
              <AlertTriangle
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-destructive"
              />
              <div>
                <p className="text-sm font-semibold text-destructive">
                  {blocker.title}
                </p>
                <p className="text-xs text-subtle">{blocker.remediation}</p>
              </div>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            Nothing has been created. This draft is kept — clear the item above
            and come back to it.
          </p>
        </div>
      ) : null}

      {refusal ? (
        <Refusal failure={refusal.failure} title={refusal.title} />
      ) : null}

      {/*
        Deploy is two acts, and only one of them is visible above. It creates
        the App — and, for a repository Spindrift holds no row for, it commits
        this file to that repository in the configuration pull request §15 makes
        authoritative. Agreeing to the first is not agreeing to the second
        unless the second is on screen.
      */}
      {spindriftFile !== null && draft.source.kind === 'repo' ? (
        <Declaration
          title="What lands in the repository"
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
              : `${draft.source.repo} is already connected, so Deploy commits nothing — this is what its ${draft.source.subpath === '.' ? 'spindrift.yaml' : `${draft.source.subpath}/spindrift.yaml`} would say if it were connected now.`
          }
          text={spindriftFile}
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={blockers.length > 0 || submitting || saving || detecting}
          onClick={start}
        >
          <Rocket aria-hidden="true" />
          {/* Every arm of the disable expression says which one it is. Reading
              the repository was the one that did not, so the button went dead
              on open — before anybody had touched it — under a label promising
              it would create something. */}
          {submitting
            ? 'Creating…'
            : saving
              ? 'Saving…'
              : detecting
                ? 'Reading the repository…'
                : 'Deploy'}
        </Button>
        <p className="text-xs text-muted-foreground">
          {blockers.length > 0
            ? 'Spindrift stops before Build #1.'
            : 'Creating the App locks its vessel and dispatches the first Build.'}
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
 * Source, which is the one row that is genuinely a question.
 *
 * Everything below it is downstream of this answer, which is why it is first
 * and why choosing a repository detects immediately rather than waiting for a
 * Continue: the rows underneath are wrong until it has.
 */
function SourceRow({
  draft,
  dispatch,
  repos,
  scopes,
  detecting,
  trouble,
  unchosen,
  onSelectRepo,
  onChooseScope,
  onSettleSubpath,
}: {
  draft: Draft;
  dispatch: Dispatch<DraftAction>;
  repos: readonly RepositoryChoice[];
  /** What the last read said, or `null` before anything has been read. */
  scopes: readonly InspectedScope[] | null;
  detecting: boolean;
  trouble: DetectionTrouble | null;
  /** Detection is offering candidates and the draft names none of them. */
  unchosen: boolean;
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
    <Row
      label="Source"
      // Open whenever the source is still the question — which includes a
      // repository whose directory nothing has answered for yet, not only one
      // that went wrong. §3's grammar only works when the alternatives are
      // visible: a sentence about a directory Spindrift could not build is
      // unreadable while the list of directories it did read is behind a
      // pencil. A settled source collapses, because then the list is noise.
      unsettled={
        draft.source.kind === 'repo'
          ? draft.source.repo === '' ||
            unchosen ||
            trouble !== null ||
            !answeredScope(draft)
          : !draft.source.location
      }
      value={
        draft.source.kind !== 'repo'
          ? draft.source.filename
          : draft.source.repo === ''
            ? 'no repository chosen'
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
        trouble?.message ??
        (draft.source.kind === 'archive' && !draft.source.location
          ? 'Not staged yet.'
          : undefined)
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {ENTRIES.map((entry) => (
            <Choice
              key={entry.id}
              selected={draft.entry === entry.id}
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
              hint="Named, never searched — Spindrift does not roam the tree. Leave the field to read the directory it now names."
            />
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
              An archive is not read the way a repository is — nothing has
              looked inside it, so pick the kind under Component yourself.
            </p>
          </div>
        )}
      </div>
    </Row>
  );
}

/** Above this many directories, finding one by eye stops being realistic. */
const SCOPE_FILTER_AT = 6;

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
      <Eyebrow>Directories Spindrift read · {scopes.length}</Eyebrow>
      {scopes.length > SCOPE_FILTER_AT ? (
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
      ) : null}
      <div
        role="listbox"
        aria-label="Directories Spindrift read"
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
        Choosing one detects that directory and names the Component after it.
        Nothing is picked for you when there is more than one.
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
