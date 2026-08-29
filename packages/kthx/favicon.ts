/**
 * The kthx dot, 32x32, `--hot` on `--paper`: what a kthx host answers at
 * `/favicon.ico` when it has none of its own.
 *
 * Base64 in the source rather than a file in the tree — 230 bytes of binary
 * is not worth a blob in a text repo, and every host serves the same bytes.
 * Its own module so that `kthx dev` can answer with the same bytes without
 * importing the serving half and the database behind it.
 */
export const FAVICON_PATH = '/favicon.ico';

export const FAVICON = {
  bytes: Uint8Array.from(
    atob(
      'AAABAAEAICAAAAEAIADQAAAAFgAAAIlQTkcNChoKAAAADUlIRFIAAAAgAAAAIAgCAAAA/BjtowAAAJdJREFUeNpj4GUXoyliGLVg1ILhY4EMl0KkhEebchoQARlALtUsAJq1RKvyv/1WNAQUJMYaAhZYCZl8sFmNaToEAaWACsi3AOhAPKbD7cDvD3wWYA0ZrGFFjgVAdxFjOgTh8QROC4BJhXgLgIpJtgCYHIm3AKh48FlA8yCieSTTPJnSI6PRvKigR2FHj+J6tMoctWD4WwAAHXTjlJaX5F4AAAAASUVORK5CYII=',
    ),
    (character) => character.charCodeAt(0),
  ),
  type: 'image/x-icon',
};

/** Its own hash: there is no release digest behind these bytes to etag by. */
export const FAVICON_DIGEST = `sha256:${new Bun.CryptoHasher('sha256').update(FAVICON.bytes).digest('hex')}`;
