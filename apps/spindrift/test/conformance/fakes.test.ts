/**
 * The conformance suite, run against every adapter that exists (Task 12).
 *
 * Today that is the three fakes: the two store implementations are deliberately
 * deferred, so no real backend is enrolled yet. The point of running it now is
 * that the enrolment check is live before the first real adapter arrives —
 * `ADAPTERS` in the suite is what it will have to be added to, and the check
 * fails until it is also run.
 */
import { FakeBuildAdapter } from '../harness/fakes/build-adapter.ts';
import { FakeDeployAdapter } from '../harness/fakes/deploy-adapter.ts';
import { FakeSecretStore } from '../harness/fakes/store-adapter.ts';
import {
  assertEveryAdapterEnrolled,
  buildAdapterSuite,
  deployAdapterSuite,
  storeAdapterSuite,
} from './adapter-suite.ts';

deployAdapterSuite('fake', () => new FakeDeployAdapter(), 'files');

buildAdapterSuite('fake', () => new FakeBuildAdapter());

// Both pinning strategies run the same suite, because §10's claim is that
// nothing above the seam can tell them apart. One of them passing would not
// establish that.
storeAdapterSuite(
  'fake native',
  () => new FakeSecretStore({ pinning: 'NATIVE' }),
);
storeAdapterSuite(
  'fake immutable item per version',
  () => new FakeSecretStore({ pinning: 'IMMUTABLE_ITEM_PER_VERSION' }),
);

assertEveryAdapterEnrolled();
