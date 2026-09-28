import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { opensshKey } from '../src/ssh-key.ts';

function ed25519() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const x = publicKey.export({ format: 'jwk' }).x ?? '';
  return { pkcs8, pub: Buffer.from(x, 'base64url') };
}

function field(bytes: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function authorizedKey(pub: Buffer): string {
  const blob = Buffer.concat([field(Buffer.from('ssh-ed25519')), field(pub)]);
  return `ssh-ed25519 ${blob.toString('base64')}`;
}

/** The fields of an unencrypted openssh-key-v1 blob, in file order. */
function parse(key: string) {
  const body = key
    .split('\n')
    .filter((line) => line && !line.startsWith('-----'))
    .join('');
  const blob = Buffer.from(body, 'base64');
  const magic = 'openssh-key-v1\0';
  expect(blob.subarray(0, magic.length).toString()).toBe(magic);
  let at = magic.length;
  const next = () => {
    const length = blob.readUInt32BE(at);
    const bytes = blob.subarray(at + 4, at + 4 + length);
    at += 4 + length;
    return bytes;
  };
  const cipher = next().toString();
  const kdf = next().toString();
  next();
  const count = blob.readUInt32BE(at);
  at += 4;
  next();
  const secret = next();
  return { cipher, kdf, count, secret };
}

describe('opensshKey', () => {
  test('rewrites an Ed25519 PKCS#8 key in OpenSSH format with the same key', () => {
    const { pkcs8, pub } = ed25519();
    const key = opensshKey(pkcs8);

    expect(key.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----\n')).toBe(true);
    expect(key.endsWith('-----END OPENSSH PRIVATE KEY-----\n')).toBe(true);
    const { cipher, kdf, count, secret } = parse(key);
    expect({ cipher, kdf, count }).toEqual({
      cipher: 'none',
      kdf: 'none',
      count: 1,
    });
    // The two check words match, or ssh reports a wrong passphrase.
    expect(secret.readUInt32BE(0)).toBe(secret.readUInt32BE(4));
    expect(secret.length % 8).toBe(0);
    // The private half carries the public key after the seed.
    expect(secret.includes(pub)).toBe(true);
  });

  test.if(Boolean(Bun.which('ssh-keygen')))(
    'writes a key OpenSSH loads',
    () => {
      const { pkcs8, pub } = ed25519();
      const dir = mkdtempSync(join(tmpdir(), 'ssh-key-'));
      const path = join(dir, 'id_ed25519');
      writeFileSync(path, opensshKey(pkcs8), { mode: 0o600 });
      const derived = Bun.spawnSync(['ssh-keygen', '-y', '-f', path]);
      expect(derived.stderr.toString()).toBe('');
      expect(derived.stdout.toString().trim()).toBe(authorizedKey(pub));
    },
  );

  test('passes an OpenSSH key through with one trailing newline', () => {
    const key =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----';
    expect(opensshKey(`${key}\n\n`)).toBe(`${key}\n`);
  });

  test('refuses a key that is not Ed25519 or not PEM', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    expect(() => opensshKey(pem)).toThrow('not ed25519');
    expect(() => opensshKey('ssh-ed25519 AAAA')).toThrow('neither');
  });
});
