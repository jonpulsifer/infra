import { createPrivateKey, randomBytes } from 'node:crypto';

const OPENSSH_BEGIN = '-----BEGIN OPENSSH PRIVATE KEY-----';
const OPENSSH_END = '-----END OPENSSH PRIVATE KEY-----';
const PKCS8_BEGIN = '-----BEGIN PRIVATE KEY-----';
const KEY_TYPE = 'ssh-ed25519';
// Unencrypted keys pad the private section to 8 bytes.
const BLOCK = 8;

function string(bytes: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function text(value: string): Buffer {
  return string(Buffer.from(value));
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
  const key = createPrivateKey(trimmed);
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
