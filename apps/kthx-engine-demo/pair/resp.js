// Enough of the Valkey wire protocol (RESP) for server.js and job.js.

/** Commands always go out as a RESP array of bulk strings. */
export const encode = (args) =>
  `*${args.length}\r\n${args
    .map((arg) => `$${Buffer.byteLength(String(arg))}\r\n${arg}\r\n`)
    .join('')}`;

/**
 * Parses one reply at `at`, or returns `null` while the buffer holds only part of it.
 * A nil reply is `{ value: null }`; an error reply is an `Error` value, not a throw.
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

/**
 * Pipelines commands on one socket and resolves with their replies in order.
 * Rejects if any reply is an error, or when the socket idles for 5 s.
 */
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
        if (reply === null) return; // partial reply: wait for more data
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
