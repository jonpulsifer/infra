import { createPrivateKey, type KeyObject, randomBytes } from 'node:crypto';

const OPENSSH_BEGIN = '-----BEGIN OPENSSH PRIVATE KEY-----';
const OPENSSH_END = '-----END OPENSSH PRIVATE KEY-----';
const PKCS8_BEGIN = '-----BEGIN PRIVATE KEY-----';
const KEY_TYPE = 'ssh-ed25519';
// Unencrypted keys pad the private section to 8 bytes.
const BLOCK = 8;
const SEED_BYTES = 32;
// An Ed25519 PKCS#8 v1 key up to its seed, and a v2 key's fields after its
// SEQUENCE header up to the same seed (RFC 8410, RFC 5958).
const ED25519_V1_HEAD = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_V2_HEAD = Buffer.from('020101300506032b657004220420', 'hex');
// A v2 key ends with its public key as a [1] BIT STRING.
const V2_PUBLIC_TAG = Buffer.from('812100', 'hex');

function string(bytes: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function text(value: string): Buffer {
  return string(Buffer.from(value));
}

/**
 * 1Password exports Ed25519 as a v2 PKCS#8 key that also carries the public
 * key, and Bun's BoringSSL parses only v1, so a v2 key is rebuilt as v1 from
 * its seed. The public key it carries must match the one the seed derives.
 */
function privateKey(pem: string): KeyObject {
  const der = Buffer.from(
    pem
      .split('\n')
      .filter((line) => line && !line.startsWith('-----'))
      .join(''),
    'base64',
  );
  const header = (der[1] ?? 0) < 0x80 ? 2 : 2 + ((der[1] ?? 0) & 0x7f);
  const seedAt = header + ED25519_V2_HEAD.length;
  if (
    der[0] !== 0x30 ||
    !der.subarray(header, seedAt).equals(ED25519_V2_HEAD)
  ) {
    return createPrivateKey(pem);
  }
  const seed = der.subarray(seedAt, seedAt + SEED_BYTES);
  const key = createPrivateKey({
    key: Buffer.concat([ED25519_V1_HEAD, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const carried = der.subarray(der.length - SEED_BYTES);
  const tag = der.subarray(der.length - SEED_BYTES - V2_PUBLIC_TAG.length);
  if (tag.subarray(0, V2_PUBLIC_TAG.length).equals(V2_PUBLIC_TAG)) {
    const derived = Buffer.from(
      key.export({ format: 'jwk' }).x ?? '',
      'base64url',
    );
    if (!derived.equals(carried)) {
      throw new Error('the key carries a public key its seed does not derive');
    }
  }
  return key;
}

/**
 * 1Password stores an SSH key as PKCS#8, which the sandbox's OpenSSH cannot
 * load for Ed25519, so mate rewrites it in OpenSSH's own format. A key
 * already in that format passes through.
 */
export function opensshKey(pem: string): string {
  const trimmed = pem.trim();
  if (trimmed.startsWith(OPENSSH_BEGIN)) return `${trimmed}\n`;
  if (!trimmed.startsWith(PKCS8_BEGIN)) {
    throw new Error('the key is neither OpenSSH nor PKCS#8 PEM');
  }
  const key = privateKey(trimmed);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`the key is ${key.asymmetricKeyType}, not ed25519`);
  }
  const jwk = key.export({ format: 'jwk' });
  if (!jwk.d || !jwk.x) throw new Error('the key has no Ed25519 halves');
  const seed = Buffer.from(jwk.d, 'base64url');
  const pub = Buffer.from(jwk.x, 'base64url');
  const publicBlob = Buffer.concat([text(KEY_TYPE), string(pub)]);
  const check = randomBytes(4);
  const unpadded = Buffer.concat([
    check,
    check,
    text(KEY_TYPE),
    string(pub),
    string(Buffer.concat([seed, pub])),
    text(''),
  ]);
  const padding = Buffer.from(
    Array.from(
      { length: (BLOCK - (unpadded.length % BLOCK)) % BLOCK },
      (_, i) => i + 1,
    ),
  );
  const blob = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    text('none'),
    text('none'),
    text(''),
    Buffer.from([0, 0, 0, 1]),
    string(publicBlob),
    string(Buffer.concat([unpadded, padding])),
  ]).toString('base64');
  const lines = blob.match(/.{1,70}/g) ?? [];
  return [OPENSSH_BEGIN, ...lines, OPENSSH_END, ''].join('\n');
}
