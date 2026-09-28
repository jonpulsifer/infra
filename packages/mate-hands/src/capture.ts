/**
 * A command's combined output, held within bounds and shaped as pi's `Shell`
 * expects: a head or tail view within byte and line limits, the true totals,
 * and the smallest update that turns the last view sent into the next.
 */
import type {
  ShellOutputLimits,
  ShellOutputMetadata,
  ShellOutputUpdate,
  ShellOutputView,
} from './protocol.ts';

// Control characters other than tab and newline, and the Unicode
// interlinear annotation marks, as pi's capture strips them.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const UNPRINTABLE = /[\x00-\x08\x0b-\x1f￹-￻]/g;

interface Retained {
  content: string;
  outputLines: number;
  outputBytes: number;
  lastLinePartial: boolean;
  firstLineExceedsLimit: boolean;
}

export class Capture {
  private readonly decoder = new TextDecoder();
  private readonly maxBytes: number;
  private readonly maxLines: number;
  private readonly retain: 'head' | 'tail';
  private buffer = '';
  private bufferBytes = 0;
  private totalBytes = 0;
  private newlines = 0;
  private endsWithNewline = true;
  private lastLineBytes = 0;

  constructor(limits: ShellOutputLimits) {
    this.maxBytes = limits.maxBytes;
    this.maxLines = limits.maxLines;
    this.retain = limits.retain ?? 'tail';
  }

  get truncated(): boolean {
    return this.totalBytes > this.maxBytes || this.totalLines > this.maxLines;
  }

  push(chunk: Uint8Array): void {
    this.append(this.decoder.decode(chunk, { stream: true }));
  }

  /** Flushes a trailing partial character; true when that added text. */
  finish(): boolean {
    const rest = this.decoder.decode();
    this.append(rest);
    return rest !== '';
  }

  view(spillPath?: string): ShellOutputView {
    const limits = { maxBytes: this.maxBytes, maxLines: this.maxLines };
    const kept =
      this.retain === 'head'
        ? keepHead(this.buffer, limits)
        : keepTail(this.buffer, limits);
    const truncated = this.truncated;
    return {
      text: kept.content.replace(UNPRINTABLE, ''),
      truncation: {
        truncated,
        truncatedBy: truncated
          ? this.totalLines > this.maxLines
            ? 'lines'
            : 'bytes'
          : null,
        totalLines: this.totalLines,
        totalBytes: this.totalBytes,
        outputLines: kept.outputLines,
        outputBytes: kept.outputBytes,
        lastLinePartial: kept.lastLinePartial,
        firstLineExceedsLimit: kept.firstLineExceedsLimit,
        maxLines: this.maxLines,
        maxBytes: this.maxBytes,
      },
      ...(spillPath === undefined ? {} : { spillPath }),
      ...(kept.lastLinePartial ? { lastLineBytes: this.lastLineBytes } : {}),
    };
  }

  private get totalLines(): number {
    const open = this.endsWithNewline || this.totalBytes === 0 ? 0 : 1;
    return this.newlines + open;
  }

  private append(text: string): void {
    if (text === '') return;
    const bytes = Buffer.byteLength(text);
    this.totalBytes += bytes;
    let at = text.indexOf('\n');
    while (at !== -1) {
      this.newlines += 1;
      at = text.indexOf('\n', at + 1);
    }
    this.endsWithNewline = text.endsWith('\n');
    const lastNewline = text.lastIndexOf('\n');
    this.lastLineBytes =
      lastNewline === -1
        ? this.lastLineBytes + bytes
        : Buffer.byteLength(text.slice(lastNewline + 1));

    // Twice the limit is enough for any view; trimming at four times keeps
    // the trim itself rare.
    const keep = this.maxBytes * 2;
    if (this.retain === 'head') {
      if (this.bufferBytes >= keep) return;
      this.buffer = firstBytes(this.buffer + text, keep);
    } else {
      this.buffer += text;
      if (this.bufferBytes + bytes <= keep * 2) {
        this.bufferBytes += bytes;
        return;
      }
      this.buffer = lastBytes(this.buffer, keep);
    }
    this.bufferBytes = Buffer.byteLength(this.buffer);
  }
}

function lines(content: string): string[] {
  if (content === '') return [];
  const split = content.split('\n');
  if (content.endsWith('\n')) split.pop();
  return split;
}

function whole(content: string, count: number, bytes: number): Retained {
  return {
    content,
    outputLines: count,
    outputBytes: bytes,
    lastLinePartial: false,
    firstLineExceedsLimit: false,
  };
}

function keepTail(
  content: string,
  limits: { maxBytes: number; maxLines: number },
): Retained {
  const all = lines(content);
  const bytes = Buffer.byteLength(content);
  if (all.length <= limits.maxLines && bytes <= limits.maxBytes) {
    return whole(content, all.length, bytes);
  }
  const out: string[] = [];
  let size = 0;
  let lastLinePartial = false;
  for (let i = all.length - 1; i >= 0 && out.length < limits.maxLines; i--) {
    const line = all[i] ?? '';
    const cost = Buffer.byteLength(line) + (out.length > 0 ? 1 : 0);
    if (size + cost > limits.maxBytes) {
      // A last line longer than the limit keeps its end.
      if (out.length === 0) {
        out.push(lastBytes(line, limits.maxBytes));
        lastLinePartial = true;
      }
      break;
    }
    out.unshift(line);
    size += cost;
  }
  const kept = out.join('\n');
  return {
    content: kept,
    outputLines: out.length,
    outputBytes: Buffer.byteLength(kept),
    lastLinePartial,
    firstLineExceedsLimit: false,
  };
}

function keepHead(
  content: string,
  limits: { maxBytes: number; maxLines: number },
): Retained {
  const all = lines(content);
  const bytes = Buffer.byteLength(content);
  if (all.length <= limits.maxLines && bytes <= limits.maxBytes) {
    return whole(content, all.length, bytes);
  }
  if (Buffer.byteLength(all[0] ?? '') > limits.maxBytes) {
    return { ...whole('', 0, 0), firstLineExceedsLimit: true };
  }
  const out: string[] = [];
  let size = 0;
  for (const line of all) {
    if (out.length >= limits.maxLines) break;
    const cost = Buffer.byteLength(line) + (out.length > 0 ? 1 : 0);
    if (size + cost > limits.maxBytes) break;
    out.push(line);
    size += cost;
  }
  const kept = out.join('\n');
  return whole(kept, out.length, Buffer.byteLength(kept));
}

/** The end of `text` within `max` UTF-8 bytes, cut on a character boundary. */
function lastBytes(text: string, max: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return text;
  let start = bytes.length - max;
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}

function firstBytes(text: string, max: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= max) return text;
  let end = max;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

function metadataOf(view: ShellOutputView): ShellOutputMetadata {
  return {
    truncation: view.truncation,
    ...(view.spillPath === undefined ? {} : { spillPath: view.spillPath }),
    ...(view.lastLineBytes === undefined
      ? {}
      : { lastLineBytes: view.lastLineBytes }),
  };
}

/** The update that turns `sent` into `next`, as pi's capture computes it. */
export function diff(
  sent: ShellOutputView | undefined,
  next: ShellOutputView,
): ShellOutputUpdate {
  if (sent === undefined) return { kind: 'replace', output: next };
  const metadata = metadataOf(next);
  if (next.text === sent.text) return { kind: 'metadata', metadata };
  if (next.text.startsWith(sent.text)) {
    return {
      kind: 'append',
      text: next.text.slice(sent.text.length),
      metadata,
    };
  }
  const scan = Math.min(
    sent.text.length,
    next.text.length,
    next.truncation.maxBytes * 2,
  );
  const shared = overlap(sent.text, next.text, scan);
  if (shared > 0) {
    return {
      kind: 'slide',
      drop: sent.text.length - shared,
      text: next.text.slice(shared),
      metadata,
    };
  }
  return { kind: 'replace', output: next };
}

/** The longest suffix of `before` that starts `after`, probing few candidates. */
function overlap(before: string, after: string, scan: number): number {
  if (scan === 0) return 0;
  const tail = before.slice(before.length - scan);
  for (const probeLength of [Math.min(64, after.length), 1]) {
    const probe = after.slice(0, probeLength);
    let candidates = 0;
    for (
      let at = tail.indexOf(probe);
      at !== -1 && candidates < 8;
      at = tail.indexOf(probe, at + 1)
    ) {
      candidates += 1;
      const length = tail.length - at;
      if (length <= after.length && after.startsWith(tail.slice(at))) {
        return length;
      }
    }
    if (probeLength === 1) break;
  }
  return 0;
}
