/**
 * A TCP proxy in front of Postgres whose `freeze` stops every byte both ways
 * without closing anything, as a peer that vanishes without a reset does.
 */
export interface StallingProxy {
  /** `url` with its host and port pointed at the proxy. */
  readonly url: string;
  freeze(): void;
  stop(): void;
}

interface Client {
  upstream?: Bun.Socket<undefined>;
  queue: Uint8Array[];
}

export function stallingProxy(url: string): StallingProxy {
  const target = new URL(url);
  const upstreams = new Set<Bun.Socket<undefined>>();
  let frozen = false;
  const server = Bun.listen<Client>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      async open(client) {
        client.data = { queue: [] };
        const upstream = await Bun.connect({
          hostname: target.hostname,
          port: Number(target.port),
          socket: {
            data(_, chunk) {
              if (!frozen) client.write(chunk);
            },
            close() {
              if (!frozen) client.end();
            },
          },
        });
        upstreams.add(upstream);
        client.data.upstream = upstream;
        for (const chunk of client.data.queue.splice(0)) upstream.write(chunk);
      },
      data(client, chunk) {
        if (frozen) return;
        if (client.data.upstream) client.data.upstream.write(chunk);
        else client.data.queue.push(new Uint8Array(chunk));
      },
      close(client) {
        if (!frozen) client.data.upstream?.end();
      },
    },
  });
  const proxied = new URL(url);
  proxied.hostname = '127.0.0.1';
  proxied.port = String(server.port);
  return {
    url: proxied.toString(),
    freeze: () => {
      frozen = true;
    },
    stop: () => {
      server.stop(true);
      for (const upstream of upstreams) upstream.end();
    },
  };
}
