/**
 * Byte helpers with no runtime dependency, so browser and server code share one
 * base64url codec and one constant-time comparison.
 */

/** WebCrypto accepts it; a SharedArrayBuffer view does not type-check. */
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

/** `null` for anything that is not unpadded base64url. */
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

/** Constant time for equal lengths: no early exit at the first difference. */
export function equalBytes(left: Bytes, right: Bytes): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

/** Constant time over the UTF-8 bytes. */
export function equalText(left: string, right: string): boolean {
  return equalBytes(
    new TextEncoder().encode(left),
    new TextEncoder().encode(right),
  );
}
