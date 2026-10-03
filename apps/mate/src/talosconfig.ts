/**
 * The sandbox's talosconfig, checked once at boot: every context's client
 * certificate must carry the `os:reader` role and no other.
 */
import { X509Certificate } from 'node:crypto';

export const READER_ROLE = 'os:reader';

interface TalosContext {
  readonly crt?: unknown;
}

/**
 * The file as read, or a throw saying why it is refused. The Talos API takes
 * its roles from the certificate's Organization and cannot revoke one, so an
 * `os:admin` file stored by mistake would hand every sandbox the nodes.
 */
export function readerTalosconfig(text: string): string {
  const parsed = Bun.YAML.parse(text) as {
    contexts?: Record<string, TalosContext | null>;
  } | null;
  const contexts = Object.entries(parsed?.contexts ?? {});
  if (contexts.length === 0) {
    throw new Error('the talosconfig holds no context');
  }
  for (const [name, context] of contexts) {
    const crt = context?.crt;
    if (typeof crt !== 'string' || !crt) {
      throw new Error(`context ${name} holds no client certificate`);
    }
    // One field a line, and ` + ` between the values of a multi-valued RDN.
    const roles = new X509Certificate(Buffer.from(crt, 'base64')).subject
      .split(/\n| \+ /)
      .filter((field) => field.startsWith('O='))
      .map((field) => field.slice(2));
    if (roles.length === 0 || roles.some((role) => role !== READER_ROLE)) {
      throw new Error(
        `context ${name} grants ${roles.join(', ') || 'no role'}, not ${READER_ROLE} alone`,
      );
    }
  }
  return text;
}
