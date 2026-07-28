/**
 * A `CommandContext` that is a tripwire rather than a stub.
 *
 * Several tests exercise paths that must refuse *before* a handler runs — a
 * name that is not a command, input that fails its schema, a request with no
 * session. Asserting the status code proves the refusal happened; it does not
 * prove nothing else happened first. This context closes that gap: every field
 * throws when touched, so a refusal that quietly opened a connection or read
 * the clock on its way out fails the test that thought it was checking a status
 * code.
 *
 * It is deliberately not a partial context with a real database attached. The
 * point is the negative claim, and a context that half works can only support
 * a positive one.
 */
import type {
  AdapterRegistry,
  CommandContext,
} from '../../src/commands/types.ts';
import type { Database } from '../../src/db/client.ts';
import { fixtureManifest } from './installation.ts';

/** Reaching for any of these is the failure the caller is watching for. */
function unreachable(what: string): never {
  throw new Error(`a refused command reached the ${what}`);
}

const noDatabase = new Proxy(
  {},
  { get: () => unreachable('database') },
) as Database;

const noAdapters: AdapterRegistry = {
  deploy: () => unreachable('deploy adapter'),
  build: () => unreachable('build adapter'),
  store: () => unreachable('secret store'),
  repository: () => unreachable('repository host'),
  supplyChain: () => unreachable('supply chain'),
};

/**
 * The manifest is the one field that is real. It is data rather than a
 * capability — reading it reaches nothing — and a command refusing on input is
 * still entitled to know which installation it is refusing in.
 */
export async function unreachableContext(): Promise<CommandContext> {
  return {
    principal: { id: crypto.randomUUID(), displayName: 'Operator' },
    clock: { now: () => unreachable('clock') },
    db: noDatabase,
    adapters: noAdapters,
    manifest: await fixtureManifest(),
  };
}
