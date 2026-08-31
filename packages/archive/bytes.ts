/**
 * Runtime-neutral byte operations shared by the browser and auth verifier.
 *
 * Keeping the codec and comparison here means the two sides cannot drift on
 * base64url acceptance or accidentally grow a second security-sensitive byte
 * loop.
 */

/** A byte string WebCrypto accepts without admitting SharedArrayBuffer. */
export type Bytes = Uint8Array<ArrayBuffer>;

const BASE64URL = /^[A-Za-z0-9_-]*$/;

export function base64urlEncode(bytes: Bytes | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

/** Decode, or `null` for anything that is not base64url. */
export function base64urlDecode(value: string): Bytes | null {
  if (!BASE64URL.test(value)) return null;
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

/** Compare equal-length bytes without leaking the first differing position. */
export function equalBytes(left: Bytes, right: Bytes): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

/** UTF-8 text comparison using the same non-short-circuiting byte operation. */
export function equalText(left: string, right: string): boolean {
  return equalBytes(
    new TextEncoder().encode(left),
    new TextEncoder().encode(right),
  );
}
