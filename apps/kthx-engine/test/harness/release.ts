/**
 * A release document for fixtures that insert a Deploy row directly. Pass what
 * a test asserts on as an override, so it agrees with the rows the test inserts.
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
