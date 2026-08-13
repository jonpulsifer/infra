/**
 * Enough of the Valkey wire protocol for both entrypoints of this scope.
 *
 * Its own file so it can be checked without starting a server: `server.js`
 * listens at import, and a parser whose only exercise is "the page looked
 * right" is a parser nobody notices breaking until the demo is in front of
 * someone. `resp.test.js` runs on `node --test` — a built-in, so this scope
 * stays dependency-free like its neighbours.
 *
 * `job.js` imports it too, which is the shape of the whole scope: one image,
 * one module graph, two Components that differ by their entrypoint and by
 * nothing else.
 */

/** One RESP array, which is the only way a command is sent. */
export const encode = (args) =>
  `*${args.length}\r\n${args
    .map((arg) => `$${Buffer.byteLength(String(arg))}\r\n${arg}\r\n`)
    .join('')}`;

/**
 * Parse one reply starting at `at`, or `null` if the buffer is short.
 *
 * That `null` is the whole reason this is a parser rather than a `split`.
 * `GET` answers with a bulk string that may be `$-1` for a missing key and
 * `LRANGE` with an array of them, so a twenty-entry list does not arrive in
 * one chunk — it arrives in as many as the network felt like. A reader that
 * assumed otherwise works on a laptop and truncates on a busy cluster, which
 * is the kind of bug that looks like "the demo is flaky".
 *
 * Errors come back as `Error` values rather than throwing, so a caller reading
 * several replies can finish reading before deciding what to do about one.
 */
export function parse(buffer, at = 0) {
  const end = buffer.indexOf('\r\n', at);
  if (end === -1) return null;
  const kind = buffer[at];
  const head = buffer.slice(at + 1, end);
  const next = end + 2;

  if (kind === '+' || kind === ':') return { value: head, at: next };
  if (kind === '-') return { value: new Error(head), at: next };

  if (kind === '$') {
    const length = Number(head);
    if (length === -1) return { value: null, at: next };
    if (buffer.length < next + length + 2) return null;
    return { value: buffer.slice(next, next + length), at: next + length + 2 };
  }

  if (kind === '*') {
    const count = Number(head);
    if (count === -1) return { value: null, at: next };
    const items = [];
    let cursor = next;
    for (let index = 0; index < count; index += 1) {
      const item = parse(buffer, cursor);
      if (item === null) return null;
      items.push(item.value);
      cursor = item.at;
    }
    return { value: items, at: cursor };
  }

  return { value: new Error(`unreadable reply: ${kind}${head}`), at: next };
}

/** Send commands down one socket, resolve with their replies in order. */
export function talk(connect, url, commands) {
  const { hostname: host, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port: Number(port) || 6379 }, () =>
      socket.write(commands.map(encode).join('')),
    );
    socket.setTimeout(5000);

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const replies = [];
      let cursor = 0;
      for (let index = 0; index < commands.length; index += 1) {
        const reply = parse(buffer, cursor);
        if (reply === null) return; // short — wait for the rest
        replies.push(reply.value);
        cursor = reply.at;
      }
      socket.end();
      const failure = replies.find((reply) => reply instanceof Error);
      if (failure) reject(failure);
      else resolve(replies);
    });

    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('timed out after 5s'));
    });
    socket.once('error', reject);
  });
}
