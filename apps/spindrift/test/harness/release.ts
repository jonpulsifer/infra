/**
 * A release document for fixtures that insert a Deploy row directly.
 *
 * `deploys.desired` is `NOT NULL` because an intent whose meaning has to be
 * reassembled from rows that have moved since is not an intent. That is a real
 * constraint rather than a formality, so a fixture has to state one — and most
 * fixtures do not care what is in it, which is what this is for.
 *
 * Anything a test *asserts* on — the names that build a hostname, the reach a
 * route is rendered at, the config a delivery carries — is passed as an override
 * rather than defaulted here, because a default that silently disagreed with the
 * `components` row a test also inserted would make the test pass for the wrong
 * reason.
 */

import type { DesiredDocument } from '../../src/domain/desired-state.ts';
import { DEFAULT_PLATFORM } from '../../src/domain/placement.ts';

export function aDesiredDocument(
  overrides: Partial<DesiredDocument> = {},
): DesiredDocument {
  return {
    app: 'app',
    component: 'web',
    target: 'target',
    kind: 'service',
    expose: true,
    reach: 'private',
    auth: 'proxy',
    config: [],
    requirements: { platform: DEFAULT_PLATFORM, resources: {} },
    ...overrides,
  };
}
