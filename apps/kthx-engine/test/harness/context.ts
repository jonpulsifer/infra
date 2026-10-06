/**
 * A `CommandContext` whose every capability throws when touched, so a test of a
 * refusal also proves nothing ran before the handler refused.
 */
import type {
  AdapterRegistry,
  CommandContext,
} from '../../src/commands/types.ts';
import type { Database } from '../../src/db/client.ts';
import { fixtureManifest } from './installation.ts';

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

/** The manifest is real: it is data, and reading it reaches nothing. */
export async function unreachableContext(): Promise<CommandContext> {
  return {
    principal: { id: crypto.randomUUID(), displayName: 'Operator' },
    clock: { now: () => unreachable('clock') },
    db: noDatabase,
    adapters: noAdapters,
    manifest: await fixtureManifest(),
  };
}
