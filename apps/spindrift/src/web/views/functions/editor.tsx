/**
 * One Function's screen — write it, run it in the preview sandbox, deploy it,
 * watch it, remove it. Everything a `fetch(request, env)` handler has: the
 * `ponytail:` note in `functions/contract.ts` keeps this a one-table feature
 * with no App, Build or Deploy of its own.
 *
 * A create and an edit are the same form: `existing` is `null` until the row
 * exists, `name` is the only field that closes once it does, and Save answers
 * both the same way — upsert, deploy, report the URL or the refusal on the row.
 */
import { useEffect, useRef, useState } from 'react';
import type {
  FunctionDetail,
  FunctionProbe,
  FunctionTarget,
  LogLine,
} from '../../../commands/views.ts';
import {
  ENV_NAME_PATTERN,
  FUNCTION_CONTRACT,
  FUNCTION_NAME_PATTERN,
  FUNCTION_TARGETS,
  type FunctionLogEntry,
  type PreviewResult,
  RESERVED_FUNCTION_NAMES,
} from '../../../functions/contract.ts';
import {
  loadMonaco,
  type MonacoEditorInstance,
  type MonacoNamespace,
  type MonacoRange,
} from '../../client/monaco.ts';
import { command } from '../../client.ts';
import { EmptyState, LogPane, Notice } from '../../components/log-pane.tsx';
import { type Cadence, useRead } from '../../poll.ts';
import { subscribeFunctionLog } from '../../stream-client.ts';
import { Badge, Dot } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../ui/collapsible.tsx';
import { CopyButton } from '../../ui/copy.tsx';
import { Field, Input, Label } from '../../ui/field.tsx';
import { Page, PageHeader } from '../../ui/page.tsx';
import { notify } from '../../ui/toast.tsx';
import { cn } from '../../ui/utils.ts';
import { DetailSkeleton, ScreenFailure, ScreenNotFound } from '../screen.tsx';
import { SNIPPETS } from './snippets.ts';

const TARGET_LABEL: Record<FunctionTarget, string> = {
  'cloudflare-workers': 'Cloudflare Workers',
  'cloud-run-functions': 'Cloud Run functions',
};

const METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const;

const DEFAULT_SOURCE = `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    return Response.json({ hello: 'world', path: url.pathname });
  },
};
`;

function logLine(entry: FunctionLogEntry): LogLine {
  return {
    text: `${entry.at} · ${entry.line}`,
    tone:
      entry.level === 'error'
        ? 'error'
        : entry.level === 'debug'
          ? 'muted'
          : undefined,
  };
}

/** While not ready. Fast enough that "Live" replaces the warning within a beat. */
const PROBE_MS = 10_000;

/**
 * Once ready. A redeploy changes `deployedAt`, which restarts this hook and
 * probes again immediately — nothing between here and there is worth a tick
 * over.
 */
const PROBE_SETTLED_MS = 5 * 60_000;

/**
 * Whether a deployed Function is answering yet (`functions/readiness.ts`).
 * Its own component so it mounts only beside a URL that exists — probing a
 * Function with nothing to probe would be a call for an answer nobody asked.
 */
function FunctionReadiness({
  name,
  deployedAt,
}: {
  readonly name: string;
  readonly deployedAt: string | null;
}) {
  const cadence: Cadence<readonly [FunctionProbe]> = (value) =>
    value?.[0].ready ? PROBE_SETTLED_MS : PROBE_MS;
  const read = useRead([['probeFunction', { name }]] as const, cadence, [
    name,
    deployedAt,
  ]);
  if (read.type !== 'success') return null;
  const [probe] = read.value;
  return (
    <Badge tone={probe.ready ? 'success' : 'warning'}>
      <Dot pulse={!probe.ready} /> {probe.ready ? 'Live' : probe.detail}
    </Badge>
  );
}

/** A native `<select>`, styled like `Input` beside it — this screen's only. */
function NativeSelect({
  id,
  value,
  options,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly value: string;
  readonly options: readonly string[];
  readonly disabled?: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <select
      id={id}
      name={id}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.value)}
      className="h-9 w-full rounded-sm border border-input bg-background px-3 font-mono text-body text-foreground disabled:cursor-not-allowed disabled:opacity-60"
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

/**
 * The saved keys, edited as a pending diff (`Record<name, value | null>`)
 * rather than in place — values are write-only, so this section never holds
 * one it did not just receive from the person typing it, and Save is the only
 * thing that turns a pending set or delete into a stored one.
 */
function EnvironmentSection({
  envKeys,
  pending,
  onChange,
}: {
  readonly envKeys: readonly string[];
  readonly pending: Readonly<Record<string, string | null>>;
  readonly onChange: (next: Record<string, string | null>) => void;
}) {
  const [revealing, setRevealing] = useState<string | null>(null);
  const [revealValue, setRevealValue] = useState('');
  const [newName, setNewName] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newIssue, setNewIssue] = useState<string | null>(null);

  const rows = [
    ...new Set([
      ...envKeys.filter((key) => pending[key] !== null),
      ...Object.keys(pending).filter((key) => pending[key] !== null),
    ]),
  ].sort();
  const changeCount = Object.keys(pending).length;

  const commitReplace = (name: string) => {
    onChange({ ...pending, [name]: revealValue });
    setRevealing(null);
    setRevealValue('');
  };

  const remove = (name: string) => {
    const next = { ...pending };
    if (envKeys.includes(name)) {
      next[name] = null;
    } else {
      delete next[name];
    }
    onChange(next);
    if (revealing === name) setRevealing(null);
  };

  const addVariable = () => {
    if (newName === '') return;
    if (!ENV_NAME_PATTERN.test(newName)) {
      setNewIssue(
        'letters, digits, underscore — starting with a letter or underscore',
      );
      return;
    }
    onChange({ ...pending, [newName]: newValue });
    setNewName('');
    setNewValue('');
    setNewIssue(null);
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border-soft p-4">
      <div className="flex items-center gap-2">
        <Label htmlFor="env-new-name">Environment</Label>
        {changeCount > 0 ? (
          <Badge tone="accent">
            {changeCount} unsaved change{changeCount === 1 ? '' : 's'}
          </Badge>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Values are write-only — set once, never shown again. Run uses the saved
        values.
      </p>

      {rows.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {rows.map((name) => (
            <div key={name} className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-body">{name}</span>
              {revealing === name ? (
                <>
                  <Input
                    autoFocus
                    value={revealValue}
                    onChange={(event) =>
                      setRevealValue(event.currentTarget.value)
                    }
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitReplace(name);
                    }}
                    className="h-8 w-48"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => commitReplace(name)}
                  >
                    OK
                  </Button>
                </>
              ) : (
                <span className="font-mono text-caption text-muted-foreground">
                  ••••••••
                </span>
              )}
              <div className="ml-auto flex gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setRevealing(name);
                    setRevealValue('');
                  }}
                >
                  Replace
                </Button>
                <Button size="sm" variant="ghost" onClick={() => remove(name)}>
                  Remove
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-2">
        <Input
          id="env-new-name"
          placeholder="NAME"
          value={newName}
          onChange={(event) => setNewName(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') addVariable();
          }}
          className="h-8 w-40 font-mono"
        />
        <Input
          placeholder="value"
          value={newValue}
          onChange={(event) => setNewValue(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') addVariable();
          }}
          className="h-8 w-48"
        />
        <Button size="sm" variant="outline" onClick={addVariable}>
          Add variable
        </Button>
      </div>
      {newIssue ? <p className="text-xs text-destructive">{newIssue}</p> : null}
    </div>
  );
}

function FunctionEditor({
  existing,
  onNavigate,
}: {
  readonly existing: FunctionDetail | null;
  readonly onNavigate: (path: string) => void;
}) {
  const isNew = existing === null;
  const [name, setName] = useState(existing?.name ?? '');
  const [target, setTarget] = useState<FunctionTarget>(
    existing?.target ?? FUNCTION_TARGETS[0],
  );
  const [row, setRow] = useState<FunctionDetail | null>(existing);
  const [pendingEnv, setPendingEnv] = useState<Record<string, string | null>>(
    {},
  );
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const [method, setMethod] = useState<(typeof METHODS)[number]>('GET');
  const [path, setPath] = useState('/');
  const [body, setBody] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PreviewResult | null>(null);

  const [live, setLive] = useState(false);
  const [liveLines, setLiveLines] = useState<readonly LogLine[]>([]);

  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<MonacoEditorInstance | null>(null);
  const saveRef = useRef<() => void>(() => {});

  const nameIssue =
    !isNew || name === ''
      ? null
      : RESERVED_FUNCTION_NAMES.has(name)
        ? `${name} is reserved`
        : FUNCTION_NAME_PATTERN.test(name)
          ? null
          : 'lowercase letters, digits and hyphens, starting with a letter';

  /**
   * Monaco's own TypeScript-worker formatter. Best-effort: the worker is a
   * separate CDN fetch that Monaco tears down after idling and respawns on
   * demand, so a format that never answers must not hold a Save hostage.
   */
  const format = () =>
    Promise.race([
      editor.current
        ?.getAction('editor.action.formatDocument')
        ?.run()
        .catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
    ]);

  const save = async () => {
    if (isNew && (name === '' || nameIssue !== null)) return;
    // A hostname the edge has not served before: the first deploy, or a move
    // onto Workers from the other target. A redeploy keeps its certificate.
    const newHostname =
      target === 'cloudflare-workers' &&
      (row === null || row.url === null || row.target !== target);
    setSaving(true);
    try {
      await format();
      const source = editor.current?.getValue() ?? '';
      const outcome = await command('saveFunction', {
        name,
        target,
        source,
        env: pendingEnv,
      });
      if (!outcome.ok) {
        // A target this installation cannot reach refuses the deploy, not the
        // save: the row is written, so a new function has a page to go to.
        const saved = outcome.failure.code === 'NOT_DEPLOYABLE';
        notify({
          tone: saved ? 'warning' : 'destructive',
          title: saved ? 'Saved — not deployed' : 'Save failed',
          detail: outcome.failure.message,
        });
        if (saved && isNew) onNavigate(`/functions/${name}`);
        return;
      }
      setRow(outcome.value.function);
      setPendingEnv({});
      if (outcome.value.function.error) {
        notify({
          tone: 'warning',
          title: 'Saved — deploy failed',
          detail: outcome.value.function.error,
        });
      } else if (newHostname) {
        // Measured fact: a Workers custom domain answers instantly but its
        // certificate takes ~160s to issue, so the success toast would be
        // wrong for the next few minutes — `FunctionReadiness` says "Live"
        // once it actually is.
        notify({
          tone: 'warning',
          title: 'Deployed — the edge is issuing the certificate',
          detail: outcome.value.function.url ?? undefined,
        });
      } else {
        notify({
          tone: 'success',
          title: `Deployed ${outcome.value.function.name}`,
          detail: outcome.value.function.url ?? undefined,
        });
      }
      if (isNew) onNavigate(`/functions/${outcome.value.function.name}`);
    } finally {
      setSaving(false);
    }
  };
  saveRef.current = () => void save();

  const runIt = async () => {
    const source = editor.current?.getValue() ?? '';
    setRunning(true);
    try {
      const outcome = await command('runFunction', {
        name: row?.name,
        source,
        request: {
          method,
          path,
          ...(method !== 'GET' && body !== '' ? { body } : {}),
        },
      });
      if (!outcome.ok) {
        notify({
          tone: 'destructive',
          title: 'Run failed',
          detail: outcome.failure.message,
        });
        return;
      }
      setResult(outcome.value);
    } finally {
      setRunning(false);
    }
  };

  const insertSnippet = (id: string) => {
    const snippet = SNIPPETS.find((candidate) => candidate.id === id);
    const instance = editor.current;
    if (snippet === undefined || instance === null) return;
    const selection: MonacoRange = instance.getSelection();
    instance.executeEdits('snippet', [
      { range: selection, text: snippet.code, forceMoveMarkers: true },
    ]);
    instance.focus();
  };

  const deleteIt = async () => {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setDeleting(true);
    try {
      const outcome = await command('deleteFunction', { name });
      if (!outcome.ok) {
        notify({
          tone: 'destructive',
          title: 'Delete failed',
          detail: outcome.failure.message,
        });
        setConfirmingDelete(false);
        return;
      }
      notify({ tone: 'success', title: `Deleted ${name}` });
      onNavigate('/functions');
    } finally {
      setDeleting(false);
    }
  };

  // Mounted once: `FunctionScreen` keys this whole tree on the name, so a
  // different Function is a different mount rather than a value swap here.
  useEffect(() => {
    let disposed = false;
    void loadMonaco().then((ns: MonacoNamespace) => {
      if (disposed || container.current === null) return;
      const instance = ns.editor.create(container.current, {
        value: existing?.source ?? DEFAULT_SOURCE,
        language: 'javascript',
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 13,
      });
      instance.addCommand(ns.KeyMod.CtrlCmd | ns.KeyCode.KeyS, () =>
        saveRef.current(),
      );
      editor.current = instance;
    });
    return () => {
      disposed = true;
      editor.current?.dispose();
      editor.current = null;
    };
  }, []);

  useEffect(() => {
    if (!live || existing === null) return;
    setLiveLines([]);
    const unsubscribe = subscribeFunctionLog(
      { name: existing.name },
      (message) => {
        if (message.kind === 'error') {
          setLiveLines((current) => [
            ...current,
            { text: message.message, tone: 'error' },
          ]);
          return;
        }
        setLiveLines((current) => [
          ...current,
          ...message.entries.map(logLine),
        ]);
      },
    );
    return unsubscribe;
  }, [live, existing]);

  const consoleLines = result ? result.logs.map(logLine) : [];

  return (
    <Page>
      <PageHeader
        eyebrow="Function"
        title={isNew ? 'New function' : name}
        description={FUNCTION_CONTRACT}
        actions={
          <>
            {existing !== null ? (
              <Button
                variant={confirmingDelete ? 'destructive' : 'outline'}
                disabled={deleting}
                onClick={() => void deleteIt()}
              >
                {confirmingDelete ? 'Confirm delete' : 'Delete'}
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => onNavigate('/functions')}>
              All functions
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-[minmax(0,240px)_1fr]">
        <Field
          name="function-name"
          label="Name"
          value={name}
          disabled={!isNew}
          issue={nameIssue}
          hint={isNew ? 'a-z, 0-9, hyphens — starts with a letter' : undefined}
          placeholder="my-function"
          onChange={(event) => setName(event.currentTarget.value)}
        />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="function-target">Target</Label>
          <div
            id="function-target"
            className="inline-flex w-fit rounded-sm border border-border"
          >
            {FUNCTION_TARGETS.map((candidate) => (
              <button
                key={candidate}
                type="button"
                onClick={() => setTarget(candidate)}
                className={cn(
                  'px-3 py-1.5 text-body first:rounded-l-sm last:rounded-r-sm',
                  target === candidate
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {TARGET_LABEL[candidate]}
              </button>
            ))}
          </div>
        </div>
      </div>

      <EnvironmentSection
        envKeys={row?.envKeys ?? []}
        pending={pendingEnv}
        onChange={setPendingEnv}
      />

      {row?.error ? (
        <Notice tone="destructive" label="Deploy failed">
          {row.error}
        </Notice>
      ) : null}
      {row?.url ? (
        <div className="flex items-center gap-1.5 text-body">
          <a
            href={row.url}
            target="_blank"
            rel="noreferrer noopener"
            className="truncate font-mono text-primary underline-offset-2 hover:underline"
          >
            {row.url}
          </a>
          <CopyButton value={row.url} label="URL" />
          <FunctionReadiness name={row.name} deployedAt={row.deployedAt} />
        </div>
      ) : null}

      <div
        ref={container}
        className="h-[60vh] w-full overflow-hidden rounded-md border border-border"
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={saving || (isNew && !name)}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <span className="text-caption text-muted-foreground">⌘S / Ctrl+S</span>
        <Button variant="outline" onClick={() => void format()}>
          Format
        </Button>
        <span className="text-caption text-muted-foreground">also on save</span>
        <select
          aria-label="Insert snippet"
          value=""
          onChange={(event) => {
            const { value } = event.currentTarget;
            event.currentTarget.value = '';
            if (value !== '') insertSnippet(value);
          }}
          className="h-9 rounded-sm border border-input bg-background px-3 font-mono text-body text-foreground"
        >
          <option value="" disabled>
            Insert snippet…
          </option>
          {SNIPPETS.map((snippet) => (
            <option
              key={snippet.id}
              value={snippet.id}
              title={snippet.description}
            >
              {snippet.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-3 rounded-md border border-border-soft p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-28">
            <Label htmlFor="run-method">Method</Label>
            <NativeSelect
              id="run-method"
              value={method}
              options={METHODS}
              onChange={(value) => setMethod(value as (typeof METHODS)[number])}
            />
          </div>
          <div className="min-w-0 flex-1">
            <Field
              name="run-path"
              label="Path"
              value={path}
              onChange={(event) => setPath(event.currentTarget.value)}
            />
          </div>
          <Button
            variant="outline"
            disabled={running}
            onClick={() => void runIt()}
          >
            {running ? 'Running…' : 'Run'}
          </Button>
        </div>
        {method !== 'GET' ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="run-body">Body</Label>
            <textarea
              id="run-body"
              value={body}
              onChange={(event) => setBody(event.currentTarget.value)}
              rows={3}
              className="w-full rounded-sm border border-input bg-background px-3 py-2 font-mono text-body text-foreground"
            />
          </div>
        ) : null}

        {result ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={result.ok ? 'success' : 'destructive'}>
                {result.status ?? 'no response'}
              </Badge>
              <span className="text-caption text-muted-foreground">
                {result.durationMs}ms
              </span>
              {result.error ? (
                <span className="text-caption text-destructive">
                  {result.error}
                </span>
              ) : null}
            </div>
            <Collapsible>
              <CollapsibleTrigger className="text-left text-caption text-muted-foreground hover:text-foreground">
                Response headers ({Object.keys(result.headers).length})
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-1.5 font-mono text-caption text-muted-foreground">
                {Object.entries(result.headers).map(([key, value]) => (
                  <div key={key}>
                    {key}: {value}
                  </div>
                ))}
              </CollapsibleContent>
            </Collapsible>
            <pre className="overflow-x-auto rounded-sm border border-border-soft bg-secondary/40 p-3 font-mono text-body">
              {result.body}
              {result.truncated ? '\n… truncated' : ''}
            </pre>
            {consoleLines.length > 0 ? (
              <LogPane lines={consoleLines} />
            ) : (
              <EmptyState title="No console output." />
            )}
          </div>
        ) : null}
      </div>

      {existing !== null ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLive((current) => !current)}
            >
              {live ? 'Stop live logs' : 'Live logs'}
            </Button>
          </div>
          {live ? (
            liveLines.length > 0 ? (
              <LogPane lines={liveLines} follow />
            ) : (
              <EmptyState title="No lines yet — nothing has invoked this function." />
            )
          ) : null}
        </div>
      ) : null}
    </Page>
  );
}

export function FunctionScreen({
  name,
  onNavigate,
}: {
  readonly name: string | null;
  readonly onNavigate: (path: string) => void;
}) {
  if (name === null)
    return <FunctionEditor existing={null} onNavigate={onNavigate} />;
  return <ExistingFunctionScreen name={name} onNavigate={onNavigate} />;
}

/**
 * A `null` cadence: every act on a Function is on this screen, so nothing it
 * does can invalidate what it just loaded, and re-reading under an editor with
 * unsaved keystrokes would be the workspace's own re-read bug read the other
 * way — plausible facts replacing a source the reader is mid-sentence in.
 */
function ExistingFunctionScreen({
  name,
  onNavigate,
}: {
  readonly name: string;
  readonly onNavigate: (path: string) => void;
}) {
  const read = useRead([['getFunction', { name }]] as const, null, [name]);

  if (read.type === 'loading') return <DetailSkeleton />;
  if (read.type === 'error') {
    return read.failure.code === 'NOT_FOUND' ||
      read.failure.code === 'INVALID_INPUT' ? (
      <ScreenNotFound
        title="Function not found"
        message={read.failure.message}
        onNavigate={onNavigate}
      />
    ) : (
      <ScreenFailure
        title="Failed to load Function"
        message={read.failure.message}
        width="reading"
        onRetry={read.reload}
      />
    );
  }
  const [{ function: fn }] = read.value;
  return <FunctionEditor existing={fn} onNavigate={onNavigate} />;
}
