/**
 * Client certificates from a throwaway Talos OS CA, one per role set, as
 * `talosctl gen crt` signs them. Certificates only: no key is needed to read
 * a role.
 */

export const READER_CRT = `-----BEGIN CERTIFICATE-----
MIIBOzCB7qADAgECAhEA4D4v+y60mO4vQTE/l0oIrDAFBgMrZXAwEDEOMAwGA1UE
ChMFdGFsb3MwHhcNMjYxMDAyMjM1MDMyWhcNMjcxMDAyMjM1MDMyWjAUMRIwEAYD
VQQKEwlvczpyZWFkZXIwKjAFBgMrZXADIQCAIhqcVF9NSE+4q4bsJ4jSvPPDBjAT
HCkA+hZtHIv9c6NZMFcwDgYDVR0PAQH/BAQDAgeAMBMGA1UdJQQMMAoGCCsGAQUF
BwMCMB8GA1UdIwQYMBaAFBsGT/FG+sakHQx/gc0Ar7PjcxF4MA8GA1UdEQQIMAaH
BH8AAAEwBQYDK2VwA0EA1OHePuyWaFz8Rhz/ImNHvMQ5Q8/oVGaXfWp2PuDk6DPs
ULGTAkXCzw/SguyM0OfEl0wbwD8OgDiZ3F494Lu/CQ==
-----END CERTIFICATE-----
`;

export const ADMIN_CRT = `-----BEGIN CERTIFICATE-----
MIIBKTCB3KADAgECAhEAkvoCa/tpOJqSJ9zdwTmR8zAFBgMrZXAwEDEOMAwGA1UE
ChMFdGFsb3MwHhcNMjYxMDAyMjM1MDA1WhcNMjcxMDAyMjM1MDA1WjATMREwDwYD
VQQKEwhvczphZG1pbjAqMAUGAytlcAMhAOtEZVIQSkeV7ffGyWLz97jCJT9MCp+l
y4kKC5tUgGF2o0gwRjAOBgNVHQ8BAf8EBAMCB4AwEwYDVR0lBAwwCgYIKwYBBQUH
AwIwHwYDVR0jBBgwFoAUGwZP8Ub6xqQdDH+BzQCvs+NzEXgwBQYDK2VwA0EAVNdw
sXL45tnjShadLXmUco1Y9T82/t+TIJbnSA8QOaBV5rOgws+3fhixvUi4LKdDMUqQ
4PKxH0a0Mu7VRYyzDg==
-----END CERTIFICATE-----
`;

/** `os:reader` and `os:operator` in one multi-valued Organization. */
export const READER_OPERATOR_CRT = `-----BEGIN CERTIFICATE-----
MIIBUDCCAQKgAwIBAgIRAMl2Cm/aoV9i+YraYKAXb/IwBQYDK2VwMBAxDjAMBgNV
BAoTBXRhbG9zMB4XDTI2MTAwMjIzNTEyNFoXDTI3MTAwMjIzNTEyNFowKDEmMBAG
A1UEChMJb3M6cmVhZGVyMBIGA1UEChMLb3M6b3BlcmF0b3IwKjAFBgMrZXADIQDm
7nhg0d+jZBYlYPc986AhAOCn00r2gy5BteBIM0x9S6NZMFcwDgYDVR0PAQH/BAQD
AgeAMBMGA1UdJQQMMAoGCCsGAQUFBwMCMB8GA1UdIwQYMBaAFBsGT/FG+sakHQx/
gc0Ar7PjcxF4MA8GA1UdEQQIMAaHBH8AAAEwBQYDK2VwA0EAzqINgEuqApGjvysm
gS7KoshMFXL/cex9D0nG8xwm3PUUlNpL59Z0Ia7vOXfv5GV3B/cZFo+tcQwCZEN2
M58tBw==
-----END CERTIFICATE-----
`;

/** A talosconfig in `talosctl`'s shape, one context per cluster. */
export function talosconfig(crts: Record<string, string>): string {
  const [first] = Object.keys(crts);
  const contexts = Object.entries(crts)
    .map(([name, crt]) =>
      [
        `  ${name}:`,
        '    endpoints:',
        '      - 192.0.2.10',
        `    ca: ${Buffer.from('a ca').toString('base64')}`,
        `    crt: ${Buffer.from(crt).toString('base64')}`,
        `    key: ${Buffer.from('a key').toString('base64')}`,
      ].join('\n'),
    )
    .join('\n');
  return `context: ${first ?? ''}\ncontexts:\n${contexts}\n`;
}
