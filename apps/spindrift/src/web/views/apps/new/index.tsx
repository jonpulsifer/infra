/**
 * Deploying a new App. Until the draft has a source the page is one question,
 * which repository or archive; after that it is four answered rows.
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

type PlanRow = 'code' | 'type' | 'name' | 'where';

const BLOCKER_ROW = {
  SOURCE_UNAVAILABLE: 'code',
  REPOSITORY_UNAVAILABLE: 'code',
  BUILD_ROUTE_UNAVAILABLE: 'code',
  TARGET_UNAVAILABLE: 'where',
  VESSEL_UNAVAILABLE: 'where',
  // Config is set on the App's Config tab, so this sits with the App's name.
  CONFIG_INCOMPLETE: 'name',
} as const satisfies Record<CreationBlockerCode, PlanRow>;

/**
 * Blocks Deploy while detection offers several directories and the draft names
 * none of them. A directory the operator typed counts as an answer.
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
 * A repository read that failed (`unread`, which blocks Deploy) or found nothing
 * buildable (`unsupported`, which leaves the operator free to name a directory
 * and pick the kind).
 */
export interface DetectionTrouble {
  readonly kind: 'unread' | 'unsupported';
  readonly message: string;
  readonly repo: string;
  /** The directory the read asked about, absent for the whole tree. */
  readonly scope?: string;
}

/**
 * The last read's complaint, while the draft still names what it is about.
 * Derived, so editing the directory never clears a whole-repository complaint.
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
      // The Code row already shows the read's message as its reason.
      remediation:
        'Until it can be read, nothing below came from the repository.',
    },
  ];
}

function answeredScope(draft: Draft): boolean {
  return draft.scopeByOperator === true || draft.detection.scope !== undefined;
}

function issueWith(schema: ZodType<string>, value: string): string | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? null);
}

/**
 * Reports the configuration pull request once, on the way out. Connecting
 * succeeds even when the pull request fails to open, so only this says so.
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

interface Refused {
  readonly failure: TransportFailure;
  readonly title?: string;
}

/** The two reads the screen opens with, in order. */
export type CreationLoad = 'draft' | 'options';

const LOADING_NOTE = {
  draft: 'Recovering the draft…',
  options: 'Reading the Targets and repositories it can use…',
} as const satisfies Record<CreationLoad, string>;

/** A skeleton of the rows, captioned with the read still outstanding. */
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
 * Retrying is safe: a start replays onto the draft id it was handed, and the
 * other reads are queries.
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
  /** Repositories with a stored row. */
  repos: readonly RepositoryOptionView[];
  /** Repositories GitHub currently grants this installation. */
  available: readonly GrantedRepositoryView[];
  onCreated?: (app: { readonly id: string; readonly name: string }) => void;
}) {
  const [draft, setDraft] = useState(initial.draft);
  const [targets, setTargets] = useState(initialTargets);
  const [serverBlockers, setServerBlockers] = useState(initial.blockers);
  const [refusal, setRefusal] = useState<Refused | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [trouble, setTrouble] = useState<DetectionTrouble | null>(null);
  // Unfiltered, so the chooser also lists what detection could not build.
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
  // Detection's reason is about the directory it read, which can differ from
  // the subpath.
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
    // Deduped on code and title, since both sides mint SOURCE_UNAVAILABLE
    // about different facts.
    ...serverBlockers.filter(
      (server) =>
        !localBlockers.some(
          (local) => local.code === server.code && local.title === server.title,
        ),
    ),
  ];
  const target = targets.find((option) => option.targetId === draft.targetId);
  const choices = repositoryChoices(repos, available);
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

  const hasSource =
    draft.source.kind === 'repo'
      ? draft.source.repo !== ''
      : Boolean(draft.source.location);

  /**
   * The row showing its correction. Null until someone presses Edit or Done;
   * while null, the most troubled row opens itself.
   */
  const [expanded, setExpanded] = useState<PlanRow | 'none' | null>(null);
  const blockersIn = (row: PlanRow) =>
    blockers.filter((blocker) => BLOCKER_ROW[blocker.code] === row);
  /**
   * Opens the Code row even when nothing blocks, since the directory list is
   * inside it.
   */
  const codeUnsettled =
    draft.source.kind === 'repo' &&
    (standing !== null || !answeredScope(draft));
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
   * Puts the server's draft back on screen. After a stale edit every later
   * save is refused too, so re-reading is the only recovery; it drops local
   * edits.
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
      // After the read, so an edit made while it was in flight is dropped too.
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
    // Targets depend on these three. Compared by value, since actions such as
    // `entry` and `detect` change the kind too.
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
        // A slower earlier read must not overwrite the current draft's options.
        if (result.ok && draftRef.current === next)
          setTargets(result.value.options);
      });
    }
    writes.current?.edit(next);
  };

  /**
   * Reads a repository, or one named directory in it, and applies what
   * `outcomeOf` allows. A directory's answer replaces only its own row.
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
        // No scope even for a directory read: the repository failed to read.
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
   * Marks a typed directory as the operator's answer and reads it. Only on
   * settle, so a half-typed path cannot clear the unchosen-directory blocker.
   */
  const settleSubpath = () => {
    const source = draftRef.current.source;
    if (source.kind !== 'repo' || source.repo === '' || !source.subpath) return;
    dispatch({ type: 'subpath', subpath: source.subpath, settled: true });
    void inspect(source.repo, source.subpath);
  };

  // Reads the repository the draft opens on; `outcomeOf` keeps a reopened
  // draft's answers.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    const source = initial.draft.source;
    if (source.kind !== 'repo' || source.repo === '') return;
    void inspect(source.repo);
  }, []);

  // Flushes on unmount, or leaving inside the debounce loses the last edit.
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
      // With nothing left to flush, completion is the first request to carry a
      // revision another tab superseded.
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
      // Before navigating: the App's page does not mention the pull request.
      reportConfigPullRequest(outcome.result.app);
      onCreated?.({
        id: outcome.result.app.appId,
        name: outcome.result.app.name,
      });
    } finally {
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

  // Until there is a source, every row would describe code nobody chose.
  if (!hasSource) {
    return (
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5 px-5 py-6">
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

  // Rows drawn before the first read would rewrite themselves when it arrives.
  // An answered draft skips this, since the read changes nothing on it.
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

      {/* Dependency order: placement derives from kind, reach and auth. */}
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
              ? `You chose ${KIND_LABEL[draft.kind]}. Detection read ${KIND_LABEL[draft.detection.kind]} — ${draft.detection.reason}`
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

        {/* Reach and sign-in decide the candidate Targets, so they come first. */}
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
                ? // A Target mints a hostname at any reach, but nothing routes to it at `none`.
                  draft.reach === 'none'
                  ? 'Nothing routes to it, so it has no address.'
                  : // Null when the adapter reports its own address after deploy.
                    (target.canonical ??
                    'Spindrift assigns the address on the first deploy.')
                : target.reasons
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

            {/* Validation refuses sign-in at `reach: none`. */}
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
                      {/* Null when the adapter assigns its own address. */}
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
        Connecting a repository also commits this file, so the title states that
        consent.
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
        {/* A press mid-read could deploy a directory the read will refuse. */}
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

/** XMLHttpRequest, because fetch has no cross-browser upload progress event. */
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
 * The source picker: the whole page until there is a source, then the Code
 * row's correction.
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
      // The staging bucket is installation configuration, so none is named.
      const res = await uploadArchive(file, setUploadPercent);
      if (res.ok) {
        dispatch({
          type: 'archive',
          filename: res.value.filename,
          digest: res.value.digest,
          location: res.value.location,
        });
      } else if (res.failure.code === 'UNAUTHENTICATED') {
        // The app shell answers an expired session by returning to sign-in.
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
        By source kind: a stored draft can carry entry ids this list does not
        offer.
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
                // Read on blur or Enter, so a half-typed path is never read.
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
              // What the archive format sniffer accepts: gzip or ZIP magic,
              // never a plain tar.
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
 * Every directory the reads covered, in a fixed-height scroller. A directory
 * detection cannot build stays listed and disabled, with what it found.
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
            // The draft's own directory is in force even when detection cannot
            // build it.
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
 * A server refusal. The code is a closed vocabulary, so it is shown for search;
 * `title` says what the operator was doing when it arrived.
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
 * Loads the draft first, since the Targets offered depend on it, then the
 * Targets and repositories together.
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
  // Strict Mode runs effects twice in development; one id makes both starts
  // one draft.
  const startId = useRef(crypto.randomUUID());
  /** The draft on screen, so this screen's own URL rewrite is not navigation. */
  const loaded = useRef<string | null>(null);

  useEffect(() => {
    if (draftId !== null && draftId === loaded.current) return;
    if (draftId === null && loaded.current !== null) {
      // New App while a draft is open needs a fresh id, or the start replays
      // that draft.
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
