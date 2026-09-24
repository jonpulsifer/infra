import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LineSplitter,
  type ShellOutputUpdate,
  type WireError,
} from '../src/protocol.ts';

export const MAIN = join(import.meta.dir, '..', 'src', 'main.ts');

export type Answer = { result: unknown } | { error: WireError };

export interface HandsOptions {
  epoch?: number;
  cwd?: string;
  stateDir?: string;
  args?: string[];
  env?: Record<string, string>;
}

/** A daemon on pipes, driven one raw message at a time. */
export class Hands {
  readonly proc;
  readonly stderr: string[] = [];
  private readonly answers = new Map<number, (answer: Answer) => void>();
  private readonly updates = new Map<number, ShellOutputUpdate[]>();
  private nextId = 1;

  constructor(options: HandsOptions = {}) {
    this.proc = Bun.spawn(
      [
        process.execPath,
        MAIN,
        '--epoch',
        String(options.epoch ?? 1),
        '--cwd',
        options.cwd ?? tmpdir(),
        '--state-dir',
        options.stateDir ?? scratch('state'),
        ...(options.args ?? []),
      ],
      {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
          ...options.env,
        },
      },
    );
    void this.read();
    void this.readStderr();
  }

  get pid(): number {
    return this.proc.pid;
  }

  get exited(): Promise<number> {
    return this.proc.exited;
  }

  /** Answers with `{result}` or `{error}`, whichever the daemon sent. */
  call(method: string, params: unknown = {}): Promise<Answer> {
    const id = this.nextId++;
    return this.callWith(id, method, params);
  }

  callWith(id: number, method: string, params: unknown): Promise<Answer> {
    const answer = new Promise<Answer>((resolve) => {
      this.answers.set(id, resolve);
    });
    this.send({ id, method, params });
    return answer;
  }

  /** Starts a call without waiting, for one a test cancels. */
  start(method: string, params: unknown = {}) {
    const id = this.nextId++;
    return { id, answer: this.callWith(id, method, params) };
  }

  async result<T = unknown>(
    method: string,
    params: unknown = {},
  ): Promise<NoInfer<T>> {
    const answer = await this.call(method, params);
    if ('error' in answer) {
      throw new Error(`${method}: ${JSON.stringify(answer.error)}`);
    }
    return answer.result as T;
  }

  async error(method: string, params: unknown = {}): Promise<WireError> {
    const answer = await this.call(method, params);
    if (!('error' in answer)) {
      throw new Error(`${method} answered ${JSON.stringify(answer.result)}`);
    }
    return answer.error;
  }

  updatesFor(id: number): ShellOutputUpdate[] {
    return this.updates.get(id) ?? [];
  }

  send(message: unknown): void {
    this.raw(`${JSON.stringify(message)}\n`);
  }

  raw(text: string): void {
    this.proc.stdin.write(text);
    this.proc.stdin.flush();
  }

  end(): void {
    this.proc.stdin.end();
  }

  kill(): void {
    this.proc.kill('SIGKILL');
  }

  private async read(): Promise<void> {
    const splitter = new LineSplitter(
      256 * 1024 * 1024,
      (line) => this.onLine(line),
      () => {},
    );
    for await (const chunk of this.proc.stdout) splitter.push(chunk);
  }

  private async readStderr(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.proc.stderr) {
      this.stderr.push(decoder.decode(chunk, { stream: true }));
    }
  }

  private onLine(line: string): void {
    const message = JSON.parse(line);
    if (message.method === 'exec.update') {
      const { id, update } = message.params;
      this.updates.set(id, [...this.updatesFor(id), update]);
      return;
    }
    this.answers.get(message.id)?.(message);
    this.answers.delete(message.id);
  }
}

const scratches: string[] = [];

export function scratch(name = 'work'): string {
  const dir = mkdtempSync(join(tmpdir(), `mate-hands-${name}-`));
  scratches.push(dir);
  return dir;
}

export function removeScratch(): void {
  for (const dir of scratches.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** False for a missing process and for a zombie waiting to be reaped. */
export function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z';
  } catch {
    return false;
  }
}

export async function eventually(
  check: () => boolean,
  timeoutMs = 3_000,
): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (check()) return true;
    await Bun.sleep(20);
  }
  return check();
}

/** The pids a test command wrote, one per line, once all `count` are there. */
export async function pidsIn(path: string, count: number): Promise<number[]> {
  let pids: number[] = [];
  await eventually(() => {
    try {
      pids = readFileSync(path, 'utf8').split('\n').filter(Boolean).map(Number);
    } catch {
      pids = [];
    }
    return pids.length >= count;
  });
  return pids;
}
