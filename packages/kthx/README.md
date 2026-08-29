# @repo/kthx

The half of [kthx](../../docs/pages/Architecture___kthx.md) that has no
runtime behind it: the `/_/` contract (`underscore.ts`), the browser SDK
(`sdk.js`), the apex landing page (`landing.html`), and the generic favicon
(`favicon.ts`).

Both hosts import it by name. `apps/spindrift` serves it over Postgres;
`apps/kthx`'s `kthx dev` serves it over a `Map`. A `KthxStore` is all either
has to supply, which is what keeps a site that works locally working deployed.
