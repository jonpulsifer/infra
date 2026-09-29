/**
 * A TCP relay in front of Postgres that can cut one connection at a chosen
 * client message, to fail a commit at the point a test chooses.
 * It matches the plaintext protocol, so the server must not require TLS.
 */
import type { Socket } from 'bun';

export interface Cut {
  /** Text that appears in the client message to cut at. */
  match: string;
  /** Cut before the server sees the message, or after it has run it. */
  when: 'before' | 'after';
}

/** The simple-query messages Bun sends to start and end a transaction. */
export const BEGIN = 'Q\u0000\u0000\u0000\u000aBEGIN\u0000';
export const COMMIT = 'Q\u0000\u0000\u0000\u000bCOMMIT\u0000';

/** Bytes a socket has not taken yet, written again when it drains. */
class Backlog {
  private readonly chunks: Uint8Array[] = [];

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk.slice());
  }

  flush(socket: Socket<unknown>): void {
    while (this.chunks.length > 0) {
      const chunk = this.chunks[0]!;
      const written = socket.write(chunk);
      if (written < chunk.length) {
        this.chunks[0] = chunk.subarray(Math.max(0, written));
        return;
      }
      this.chunks.shift();
    }
  }
}

interface Link {
  upstream?: Socket<undefined>;
  toServer: Backlog;
  toClient: Backlog;
  cut: boolean;
}

export class FaultProxy {
  readonly url: string;
  /** Every client message, as latin1 text. */
  readonly sent: string[] = [];
  private readonly server: Bun.TCPSocketListener<Link>;
  private readonly target: { hostname: string; port: number };
  private armed: { cut: Cut; fired: () => void } | undefined;

  /** Listens on `port`, or on a free port when it is 0. */
  constructor(target: string, port = 0) {
    const upstream = new URL(target);
    this.target = {
      hostname: upstream.hostname,
      port: Number(upstream.port || 5432),
    };
    this.server = Bun.listen<Link>({
      hostname: '127.0.0.1',
      port,
      socket: {
        open: (client) => {
          client.data = {
            toServer: new Backlog(),
            toClient: new Backlog(),
            cut: false,
          };
          void this.connect(client);
        },
        data: (client, chunk) => this.relay(client, chunk),
        drain: (client) => client.data.toClient.flush(client),
        close: (client) => {
          if (!client.data.cut) client.data.upstream?.end();
        },
      },
    });
    upstream.hostname = '127.0.0.1';
    upstream.port = String(this.server.port);
    this.url = upstream.toString();
  }

  /** Cuts the next connection that sends `cut.match`; resolves when it has. */
  arm(cut: Cut): Promise<void> {
    return new Promise((fired) => {
      this.armed = { cut, fired };
    });
  }

  stop(): void {
    this.server.stop(true);
  }

  private async connect(client: Socket<Link>): Promise<void> {
    const upstream = await Bun.connect({
      ...this.target,
      socket: {
        data: (socket, chunk) => {
          if (client.data.cut) socket.end();
          else {
            client.data.toClient.push(chunk);
            client.data.toClient.flush(client);
          }
        },
        drain: (socket) => client.data.toServer.flush(socket),
        close: () => {
          if (!client.data.cut) client.end();
        },
      },
    });
    client.data.upstream = upstream;
    client.data.toServer.flush(upstream);
  }

  private relay(client: Socket<Link>, chunk: Uint8Array): void {
    const text = Buffer.from(chunk).toString('latin1');
    this.sent.push(text);
    const armed = this.armed;
    if (armed === undefined || !text.includes(armed.cut.match)) {
      this.forward(client, chunk);
      return;
    }
    this.armed = undefined;
    client.data.cut = true;
    if (armed.cut.when === 'after') this.forward(client, chunk);
    else client.data.upstream?.end();
    client.end();
    armed.fired();
  }

  private forward(client: Socket<Link>, chunk: Uint8Array): void {
    const { upstream, toServer } = client.data;
    toServer.push(chunk);
    if (upstream !== undefined) toServer.flush(upstream);
  }
}
