/**
 * The process groups a daemon starts, and its record of them in the state
 * directory. A daemon started with a newer epoch reads the records to kill
 * what older daemons left, because a pods/exec stream cannot always tell a
 * daemon that its client is gone.
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export interface Group {
  pgid: number;
  /** The leader's start time from `/proc`; null when it was already gone. */
  start: string | null;
}

export interface DaemonRecord {
  epoch: number;
  pid: number;
  start: string | null;
  groups: Group[];
}

interface Stat {
  state: string;
  pgid: number;
  start: string;
}

const RECORD = /^\d+-\d+\.json$/;
const KILL_WAIT_MS = 1_000;

function stat(pid: number): Stat | null {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The command name is in parentheses and may contain spaces.
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    return {
      state: fields[0] ?? '',
      pgid: Number(fields[2]),
      start: fields[19] ?? '',
    };
  } catch {
    return null;
  }
}

const self = stat(process.pid);
const PROCFS = self !== null;
const OWN_GROUP = self?.pgid ?? process.pid;

export function startTime(pid: number): string | null {
  return stat(pid)?.start ?? null;
}

function signal(target: number, sig: NodeJS.Signals | 0): boolean {
  try {
    process.kill(target, sig);
    return true;
  } catch {
    return false;
  }
}

/** Whether `pid` is still the recorded process, and not a zombie or a reuse. */
function isLive(pid: number, start: string | null): boolean {
  if (!PROCFS) return signal(pid, 0);
  const now = stat(pid);
  return now !== null && now.state !== 'Z' && now.start === start;
}

/**
 * Whether a group id still names the recorded group. The id stays reserved
 * while any member lives, so it names someone else only when a process with
 * a different start time holds that pid.
 */
function isOurs(group: Group): boolean {
  if (group.pgid <= 1 || group.pgid === OWN_GROUP) return false;
  const leader = stat(group.pgid);
  if (leader === null) return true;
  return group.start !== null && leader.start === group.start;
}

export function killGroup(group: Group): void {
  if (isOurs(group)) signal(-group.pgid, 'SIGKILL');
}

function groupAlive(group: Group): boolean {
  return isOurs(group) && signal(-group.pgid, 0);
}

export class Ledger {
  readonly path: string;

  constructor(
    readonly dir: string,
    readonly record: Omit<DaemonRecord, 'groups'>,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = join(dir, `${record.epoch}-${record.pid}.json`);
  }

  save(groups: Group[]): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...this.record, groups }), {
      mode: 0o600,
    });
    renameSync(tmp, this.path);
  }

  remove(): void {
    rmSync(this.path, { force: true });
  }
}

/**
 * Commands that are running, and finished commands whose background children
 * still live. Every change is saved, so a later daemon can kill them all.
 */
export class Groups {
  private readonly running = new Map<number, Group>();
  private readonly lingering = new Map<number, Group>();
  private closed = false;

  constructor(private readonly ledger: Ledger) {
    ledger.save([]);
  }

  get runningCount(): number {
    return this.running.size;
  }

  started(pid: number): Group {
    for (const [pgid, group] of this.lingering) {
      if (!groupAlive(group)) this.lingering.delete(pgid);
    }
    const group = { pgid: pid, start: startTime(pid) };
    this.running.set(pid, group);
    this.save();
    return group;
  }

  exited(group: Group): void {
    this.running.delete(group.pgid);
    if (groupAlive(group)) this.lingering.set(group.pgid, group);
    this.save();
  }

  /** Kills every group and stops recording, so the record can be removed. */
  close(): void {
    this.closed = true;
    for (const group of this.all()) killGroup(group);
    this.lingering.clear();
  }

  private all(): Group[] {
    return [...this.running.values(), ...this.lingering.values()];
  }

  private save(): void {
    if (!this.closed) this.ledger.save(this.all());
  }
}

export type Claim =
  | { superseded: DaemonRecord }
  | { superseded: null; killed: DaemonRecord[] };

/**
 * Makes `ledger`'s daemon the owner of the state directory. A record with an
 * epoch at or above its own supersedes it; every older daemon is killed, then
 * its groups. The caller saves its own record first, so of two daemons that
 * start together the newer one always sees the older.
 */
export async function claim(ledger: Ledger): Promise<Claim> {
  const { dir, record } = ledger;
  const others = records(dir).filter(
    (r) => r.epoch !== record.epoch || r.pid !== record.pid,
  );
  const newer = others.find((r) => r.epoch >= record.epoch);
  if (newer) return { superseded: newer };
  for (const old of others) {
    const path = join(dir, `${old.epoch}-${old.pid}.json`);
    if (isLive(old.pid, old.start)) {
      signal(old.pid, 'SIGKILL');
      await gone(old.pid, old.start);
    }
    // Read again: the old daemon may have started a group since.
    const groups = readRecord(path)?.groups ?? old.groups;
    for (const group of groups) killGroup(group);
    rmSync(path, { force: true });
  }
  return { superseded: null, killed: others };
}

async function gone(pid: number, start: string | null): Promise<void> {
  const until = Date.now() + KILL_WAIT_MS;
  while (isLive(pid, start) && Date.now() < until) await Bun.sleep(10);
}

function records(dir: string): DaemonRecord[] {
  const found: DaemonRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!RECORD.test(name)) continue;
    const record = readRecord(join(dir, name));
    if (record) found.push(record);
    else rmSync(join(dir, name), { force: true });
  }
  return found;
}

function readRecord(path: string): DaemonRecord | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as DaemonRecord;
    const valid =
      Number.isSafeInteger(value.epoch) &&
      Number.isSafeInteger(value.pid) &&
      Array.isArray(value.groups) &&
      value.groups.every((g) => Number.isSafeInteger(g?.pgid));
    return valid ? value : null;
  } catch {
    return null;
  }
}
