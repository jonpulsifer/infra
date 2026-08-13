/**
 * The one thing here that can be wrong without looking wrong.
 *
 * `node --test`, so the scope keeps its no-dependency rule. The cases that
 * matter are the short-buffer ones: everything else is a `split` with extra
 * steps, and a reader that mishandles a reply arriving in two chunks produces
 * a page that is silently missing rows rather than one that fails.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encode, parse } from './resp.js';

test('encodes a command as a RESP array', () => {
  assert.equal(encode(['GET', 'k']), '*2\r\n$3\r\nGET\r\n$1\r\nk\r\n');
});

test('reads the simple replies', () => {
  assert.equal(parse('+OK\r\n').value, 'OK');
  assert.equal(parse(':42\r\n').value, '42');
  assert.equal(parse('$3\r\nabc\r\n').value, 'abc');
});

test('a missing key is null, not an empty string', () => {
  // `GET` on a key nothing wrote. Rendering "" as a count of runs would be a
  // page claiming zero runs when the truth is nothing has ever written.
  assert.equal(parse('$-1\r\n').value, null);
});

test('an error reply comes back as an Error rather than throwing', () => {
  const reply = parse('-ERR wrong kind\r\n');
  assert.ok(reply.value instanceof Error);
  assert.equal(reply.value.message, 'ERR wrong kind');
});

test('reads an array of bulk strings, and reports where it ended', () => {
  const reply = parse('*2\r\n$1\r\na\r\n$2\r\nbc\r\n');
  assert.deepEqual(reply.value, ['a', 'bc']);
  assert.equal(reply.at, '*2\r\n$1\r\na\r\n$2\r\nbc\r\n'.length);
});

test('a short buffer is null at every truncation point', () => {
  // The real failure mode, enumerated: a twenty-entry LRANGE arrives in
  // however many chunks the network chose, so every prefix of a reply has to
  // read as "not yet" rather than as a shorter reply.
  const complete = '*2\r\n$1\r\na\r\n$12\r\nhello world!\r\n';
  for (let cut = 1; cut < complete.length; cut += 1) {
    assert.equal(
      parse(complete.slice(0, cut)),
      null,
      `a ${cut}-byte prefix should read as incomplete`,
    );
  }
  assert.deepEqual(parse(complete).value, ['a', 'hello world!']);
});

test('reads several replies in sequence from one buffer', () => {
  // What `talk` does: GET then LRANGE, pipelined, arriving together.
  const buffer = '$1\r\n7\r\n*1\r\n$2\r\nhi\r\n';
  const first = parse(buffer, 0);
  assert.equal(first.value, '7');
  assert.deepEqual(parse(buffer, first.at).value, ['hi']);
});
