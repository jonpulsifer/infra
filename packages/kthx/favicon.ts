/**
 * The kthx dot, 32x32, for a host with no `/favicon.ico` of its own. Its own module so
 * `kthx dev` can serve it without importing the server and its database.
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
