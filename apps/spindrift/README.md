# spindrift

Connect a repo, press Deploy, get a URL.

Spindrift is a deploy layer, not a platform: it owns the UI and the feel, and
adapts to whatever builds and delivers underneath — a Kubernetes cluster, Cloud
Run, or static hosting. The design lives in `.agent/plans/spindrift/spec.md`
(private) and is referenced from the source as `§N`.

**An uploaded bundle reaches a Kubernetes cluster and comes back with a URL.**
The five nouns have tables, the three adapter contracts are written, and
commands are the only way authenticated product operations are acted on;
pre-session authentication has its own closed internal surface. Targets can be connected,
inspected on a loop, and resolved against — asking where a Component can go
returns an answer with a reason for every Target it cannot. Uploading finished
output records an artifact without a builder; creating a Deploy writes an intent
under a locking read; the reconciler claims that intent, applies it through the
Kubernetes adapter, and records what the platform said. The operator claims the
installation with a passkey and reaches every command through an opaque
session. Source detection classifies one named repo or archive scope, honours an
authoritative `spindrift.yaml`, derives workspace watch paths, and keeps
Dockerfile selection separate from Component-kind inference.

All three build routes exist — hosted CI, the cloud builder, and an in-cluster
Job — and every one of them runs the same BuildKit program over the same
staged bundle, so which route ran is a property of a Build rather than a
different pipeline.

All three deploy backends exist too — a cluster through its GitOps operator, the
cloud runtime through its own API, and static hosting through a release — and
one conformance suite runs over every one of them, which is what keeps "core
describes, the adapter renders" a tested claim rather than a stated one.

Datastore provisioning has no command yet: the App workspace lists what the
`datastores` table and each adapter already know (`src/adapters/datastore/`),
but nothing creates or attaches one. Jobs run end to end on `kubernetes` and
`cloudrun` — `runComponent` presses one and the App workspace reads its
executions back from the platform, never from a core-side guess. The App
workspace and Deploy screen query command-owned state; authenticated
WebSockets carry durable build and deploy attempt events separately from
adapter-owned runtime output. `test/fixtures/scenarios.ts` remains as an
explicit standalone scenario for developing the views without a database.

One named gap is deliberate:

- **The status page is not served yet.** §9 wants a URL that resolves from the
  moment an App exists, on a lowest-precedence wildcard route. Naming is here and
  a deployed Component's names resolve through its route; the wildcard route and
  the page it points at are not, so an App's address stays dark until something
  has actually been deployed to it.

## Shape

One image, two processes (§19): `web` serves the product surface and
`reconciler` independently supervises the polling work.

| Path | What it is |
| --- | --- |
| `src/config/` | the installation manifest and its schema |
| `src/db/` | the Drizzle schema, the connection, and the committed migrations |
| `src/commands/` | the application command layer and its registry |
| `src/domain/` | backend-neutral product rules and value types |
| `src/adapters/` | the adapter contracts, the three deploy backends, the three build routes, the datastore adapters, and the two stores |
| `src/reconciler/` | the independently supervised reconciliation process |
| `src/supply-chain/` | provenance verification, core signing, and derived posture |
| `src/web/` | the `web` process — the server, the dispatch surface, and the client |
| `src/web/ui/` | shadcn primitives, in this installation's palette |
| `src/web/views/` | the object explorers, detail views, creation flow, and Settings surfaces (§18) |
| `build.ts` | `Bun.build` over the client HTML entry → `dist/` |

There is no framework, no bundler beyond Bun, and no test runner beyond
`bun test`. Navigation, form state, and data loading are hand-rolled, which is
the cost the plan accepted for staying Bun-native.

## The UI

Tailwind v4 and shadcn primitives, compiled by `bun-plugin-tailwind` inside the
same graph walk that bundles the client.

**Two entries, because the client is compiled at two different times.**
`src/web/dev.ts` uses Bun's HTML import, so `bun run dev` compiles on demand and
an edit is visible without a build step. `src/web/server.ts` — what the image
runs — serves `dist/` as files and imports no HTML module at all, which is what
keeps Tailwind, the bundler, and TypeScript out of the runtime: the shipped
image installs `drizzle-orm` and `zod` and nothing else. Both build their route
tables the same way, and `src/web/serve.ts` is everything else they share.

That split is the reason the UI's libraries — React, Radix, lucide — are
`devDependencies` rather than dependencies. They are build inputs that end up
inside `dist/`; the server never resolves one. `test/web/routes.test.ts` reads
the server's module graph and fails if that stops being true.

The palette is not a choice made here: `src/web/client/styles.css` carries the
tokens the prototypes settled, bound to shadcn's token names so `bg-card` and
`text-muted-foreground` resolve to them. Light and dark both ship; the toggle
stamps `data-theme` on the root, and its absence means "follow the OS".

The operational rail separates Overview, Apps, Supply chain, and Deploys. Supply
chain is one entry over three ledgers — Sources, Builds, Artifacts — because
that is §2's chain read left to right: a Source plus a Build is an Artifact, and
an Artifact plus config is a Deploy. Deploy stays its own entry: it is the act
that puts something in front of users, not the last stage of a pipeline. Each
list uses the object-explorer pattern: stable objects on the left and evidence
for the selection on the right. Settings owns Connections, identity,
installation, notifications, and destructive controls — and Connections is every
system outside Spindrift that Spindrift holds an address for, in supply-chain
order: repositories, source buckets, artifact registries, Targets.

The detail surfaces implement rules §18 and identity settled rather than
choices made while building them:

- **Attempt** (`views/apps/deploy-detail.tsx`) — App-first, not attempt-first.
  State and URL, then diagnosis, then what the release is made of, then a dense
  resource list, then the logs. No stage rail. `blame` gets a chip, the build
  log opens only when the *build* is what failed, and **the red screen says the
  previous release is still serving**. It serves two routes, because pressing
  Deploy has two outcomes: `/deploys/:id` for an intent, and `/builds/:id` for a
  a Build — same evidence structure with a null release id. A placed Build stays
  inspectable as artifact production and links to its related Deploy.
- **Workspace** (`views/apps/workspace.tsx`) — live state and URL lead; Target
  and the immutable vessel are visible; Components and Datastores are peer
  sections; its three newest Build/Deploy checkpoints link to the attempts they
  came from, while the global ledgers retain the complete cursor-paged history.
  A website states that it has no runtime instead of showing an empty log.
  **The Components list is the selector**, and the screen's per-Component half
  — the headline, the runtime, the config keys, the placement, the release and
  the Component `Deploy` and `Rebuild` act on — is whichever row is pressed:
  `getAppWorkspace` takes that Component by name and answers with the App's
  first when none is named, which is how an App's job reaches its run list and
  its Run now control from behind its service.
- **Create** (`views/apps/new/`) — Source → Component → Place → Configure →
  Review, defaults carrying every step, preflight folded into Review. The
  server-owned draft survives refresh and rejects stale concurrent edits. An
  unmet prerequisite stops before any App, Component, Build, or Deploy exists,
  keeps the draft, and names what clears it. **It offers what exists rather
  than deciding from it.** The picker is every repository the GitHub grant
  carries merged with the ones Spindrift holds rows for, each row saying which
  it is; detection runs on the repository the draft opens on, and every
  directory it read is a row — buildable ones selectable with their reason, the
  rest wearing what was found instead (§3). A sole candidate is a proposal and
  two are a question, so nothing is picked for anybody — and a draft somebody
  has already answered is read again without being re-decided, because the
  draft records which directory its reason is about and which answers are the
  operator's. **Selecting writes nothing**: `inspectRepository` is a read, and
  a repository the grant offers
  gets §15's row and configuration pull request from `completeCreationDraft`,
  through `connectRepository` itself — which is what keeps "an abandoned draft
  leaves nothing behind" literally true rather than nearly true.
  **Editing it cannot strand the operator.** Writes coalesce behind a trailing
  debounce and still go one at a time, so the revision guard keeps its ordering
  while typing a name costs one round trip; leaving the screen sends what is
  scheduled. Deploy flushes those writes and answers with the save that failed
  rather than completing a draft the server does not have, and a stale revision
  — found by a save or by the press itself — re-reads the draft, resyncs the
  revision, drops the edits that version had queued and says another tab won.
  A completion that never came back says the App may exist rather than leaving
  the button creating something forever. A name the schema will refuse is
  marked at the field from that same schema, a repository nothing could be read
  from is a prerequisite until something reads it, and the id appearing in
  `/apps/new/<id>` is a rewrite rather than a navigation — which is why that one
  screen is keyed on its route.
- **Authentication Settings** (`views/auth/settings.tsx`) — additive passkeys
  and the optional Gateway binding. Every mutation requires a fresh passkey
  assertion, and the final account-root passkey cannot be removed.

**A release has a source and only sometimes a build.** §4's supplied-artifact
arm records an uploaded bundle as-is with no builder, so `DeployView` carries a
source always and a build that may be null — the screen states that no builder
was involved rather than naming one that never ran. **Rolling back deploys an
older release and rebuilds nothing** (§6: an ordinary deploy naming an older
Build), and the affordance appears only where that comparison would be accepted.

**Deleting an App is review-then-confirm**, from the App list row or the
workspace header (`components/delete-app.tsx`). `deleteApp` called without
`confirm` writes nothing and answers with what the delete would do — the
Components, Builds, Deploys and config keys that go, the Datastores that survive
detached (§11), and the live workloads it would strand. The confirm call goes by
the id the review resolved. **Nothing is torn down**: as with disconnect, a
running workload keeps running and is named again afterwards, because once the
rows are gone that list is the only record it is there. §10 store items are
reaped with the App, and a key the store refuses to destroy is named rather than
failing a delete that already happened.

Authenticated product operations reach the server through a dispatch surface
generated from the command registry (`src/web/dispatch.ts`): one route per
command, built by `Object.fromEntries` over `commandNames`. Authentication uses
a second closed internal surface generated from `AUTH_ACTS`. Both are
unversioned; product commands are session-authenticated only and neither surface
offers a bearer token that would turn this internal protocol into an API §21
declined to declare.

## Identity

The first visit claims the installation with a WebAuthn passkey and the
enrolment token from the installation Secret. The token is stored only as a
hash and is consumed on use. A rotated token is the recovery path: a successful
ceremony preserves the sole `User`, replaces every local passkey, and revokes
every local session.

Sign-in creates a random server-side session with a fixed 24-hour lifetime. The
database holds only its hash; the browser receives the value in a `Secure`,
`HttpOnly`, `SameSite=Lax` cookie. Sign-out revokes the row as well as clearing
the cookie.

The optional authenticated-Gateway adapter maps configured, trusted
issuer/subject headers to an explicitly linked stable `User`; it never
provisions an account or stores a provider token. Unknown assertions receive
`403`. The offsite manifest leaves the adapter disabled until its Gateway strips
and replaces the configured identity headers and the Service is non-bypassable,
so local passkeys are the active human-authentication path there.

Authenticated Settings can add passkeys or link and unlink the current Gateway
identity. Every authentication-method change requires a fresh passkey
assertion. Recovery remains the deployment-token path above: it replaces local
passkeys and sessions while preserving the stable `User` and Gateway binding.

## The command layer

Every authenticated product act is a command taking an explicit input and a
request context, and the registry maps name → `{ input schema, handler }`.
Authentication is the narrow exception described above: pre-session acts create
that context, and credential Settings changes how its Principal is proved.
**A route may never hold domain logic**: both internal surfaces validate and
delegate before choosing an HTTP response. A command exported but not registered
is a compile error, and so is a registry key that is not a command.

## Vessels, Targets, and placement

A **Vessel** is a tenancy boundary: the thing that admits a call or refuses it,
that owns the federation, and that can `404`. A cluster is one. A cloud project
is one. A **Target** is one runtime surface on a vessel — `Target = Vessel ×
surface` — and a Target is what an App's Component is placed on.

That is why connecting one cloud project asks about two surfaces, `cloudrun` and
`static`: placement determines artifact shape, and a single "Cloud" Target would
leave a website ambiguous between the Cloud Run rendering and the static one.

**Which surfaces a vessel carries is discovered, not derived from its kind.**
Connect probes the boundary for each surface and registers a Target for each one
it finds; a project whose Cloud Run API is switched off gets no `cloudrun`
Target and a sentence saying why. A `kind` decides one thing — which shape
`location` has — and the probe list (`PROBED_SURFACES_BY_VESSEL_KIND`) is a list
of questions rather than an answer, which is what stops a project that runs a
cluster from needing a `gcp-project-with-gke` kind. "Which surfaces does this
vessel carry" is a query over `targets`, and there is no second copy of it.

**"Not there" and "could not tell" are different answers.** Only an established
absence withholds a Target; a refused read, a missing federation or an
unreachable endpoint registers the Target unhealthy with the sentence attached,
because a confident absence rendered off a failed read is the one thing worse
than an unhealthy row. Nothing ever removes a Target that already exists — a
surface that stops answering keeps its row and fails the checklist, and the
standing loop refreshes rows without ever creating or deleting one.

**A surface found later joins the vessel when somebody asks again.** The absence
is deliberately not stored: what a boundary carries is a fact about the
boundary, and a copy of it here would go stale the moment the API is switched
on. So the answer to "it exists now" is the connect act run again, which the
Targets screen offers on a boundary that is already connected, and which changes
no Target that was already there.

The split decides where every fact lives. What is true of the boundary, and
therefore of every surface on it — where it is, which hosts it serves, which
registries it reaches — belongs to the vessel, stated once, where two surfaces
cannot disagree about it (`src/domain/vessel.ts`). What is true of one runtime
and not its neighbours — a region, a namespace, an API root, a delivery flavour —
belongs to the Target. No adapter sees the seam: `deployTargetOf` composes the
one flat view an adapter has always received out of the two rows.

**An App is not in a vessel.** It has Components, each placed on a Target, and
that Target's vessel is the boundary the Component runs in. Nothing on the App
records this, because a second answer to one question can only disagree with the
first.

**Two vessels are the installation's own**, and the manifest names them:
`installation.controlPlaneVessel` is where this control plane runs, and
`installation.homeVessel` is where its shared services live — the source bucket,
the store of record, the artifacts project and the signer. They are scalar
pointers rather than a flag, so cardinality is free and "this vessel is
undeletable" is *something points at it* rather than a column. The home vessel
carries those services as its own properties (`shared`), which is what stops a
bucket, a store and a project id from being four unrelated strings that nothing
requires to describe the same place.

Both reconcile from the mounted declaration **on every boot** and render
read-only, which narrows — and does not invert — the rule that a declaration
seeds and does not govern: every other vessel is still seed-once-then-UI-owns.
Read-only on the screens and refused underneath them: a write that would edit
either of them names the paths a boot would take back rather than saving a value
the next restart discards. Neither can be disconnected, guarded explicitly in
the command path because neither pointer is a foreign key. **The home vessel's
checklist may be red while the control plane runs on it**; that is already true
of the manifest, and the guards are what make it safe.

A boot reconciling those two moves the boundary and reassesses the surfaces on
it; it does not re-assert the manifest's copy of a connection, and it does not
null a fact the declaration is silent about. Both would undo the connect act on
every restart, which is the same rule `ManifestWrite` already keeps one noun
down.

**A vessel has a checklist of its own**, keyed by kind × role the way
`PREREQUISITES_BY_ADAPTER` keys off adapter
(`VESSEL_PREREQUISITES_BY_KIND_AND_ROLE`). The home cloud vessel is asked
whether its source bucket is there, whether the store answers, whether the
signer is a key with a signing purpose and whether the artifacts project is
visible; an app vessel is asked nothing, so it is never shown a green row for
something nobody checked. `src/reconciler/vessel-loop.ts` is the standing pass,
and it stores what was observed and never what was concluded — health is derived
at read time, exactly as a Target's is.

**An unmet row carries the change that clears it.** A sentence is the diagnosis;
the fix is always Terraform here, because Terraform owns every boundary this
installation stands on. `src/domain/remediation.ts` generates the stanza from
what the probe actually observed — the one service it found switched off, the
project it named, the bucket this installation stages into — and the vessel's
declared `terraformRoot` is where it belongs. **Composed at read time, never
stored**: a stanza moves when a root is declared or a surface is connected, and
the loops keep their rule of storing what was observed and deriving what it
means. `openPrerequisiteRemediation` opens it as a pull request against
`github.infrastructureRepository`, following `integrations/github/config-pr.ts`
exactly — one prerequisite's change, one file, and **nothing else written**: no
row moves, and applying it is what clears the checklist, which the standing loop
notices on its own.

**Unmet is not the same as observed failing.** Both checklists report a row
unmet when they could not assess it — a switched-off service stops the one probe
that would have answered the other two, and a refused listing establishes
nothing about what is in a project — so a row carries `assessed` alongside
`met`, and `remediationFor` takes the row rather than its name. An unassessed
row gets the reason there is no change, exactly as a Kubernetes one does.
Generating from it would propose a privilege grant for a call nobody made, or a
bucket nobody established was missing, with a pull request button beside it.

**And a stanza is never a second writer.** Each one carries the strings a file
that already owns the fact would contain — its resource address, and the value
it manages — and the pull request path reads the destination before it writes.
A repeating address does not parse, so the pull request would break the plan for
every other change queued against that root; a repeating value parses and is
worse, being two resources managing one enablement or one binding, which is the
drift `AGENTS.md` prohibits by name. Both are refused with the file named.

Two more things it deliberately will not do. **It never invents a location**: a
boundary declaring no root gets "this vessel has no Terraform root; here is what
one would contain", and the act refuses rather than creating a root whose
backend and provider pin nothing here observed. And **it never emits a
placeholder**: a grant needs the exact principal, which is a fact Spindrift holds
only where its federation impersonates a service account, so an installation
federating directly gets no stanza and the reason instead. Most rows are like
that by nature — a delivery operator, a chart source and a writable store are
cleared inside a cluster, and a vessel is a project §14 forbids creating — so
"no generated remediation" is a state with a sentence rather than an empty box,
the same split `cloud-discovery.ts` keeps between `found: []` and `unavailable`.

**A Target has no name.** `Target = Vessel × surface` is its identity as well as
its definition: the pair is naturally unique — a boundary carries one runtime of
each kind — so it is the unique index, it is what `connectTarget` and
`disconnectTarget` take, and it is what the screens show, as
`<vessel>/<adapter>`. There is nothing to construct and so nothing to rename when
a vessel turns out to carry a surface nobody had registered.

A Target is flat and has exactly one adapter type. That one connect act asks for
both control APIs, and each Target keeps only the endpoint its own adapter
drives: an endpoint is connection material for exactly the reason a cluster's
API server is, because two connected projects may sit behind different regional
or perimeter-fronted endpoints and neither is more correct. **Connect always
succeeds**: an unreachable cluster still produces a Target, unhealthy, with every
unmet prerequisite and the sentence behind it. **Disconnect strands rather than
stops**: live Deploys go orphaned, nothing is destroyed, the confirmation names
what it left running, and reconnecting re-adopts whatever `observe` still finds.

One loop (`src/reconciler/target-loop.ts`) refreshes health and capabilities
together, because a connect-time snapshot rots. It stores what was observed and
never what was concluded — `verifiedDeploy` and `offlineDeploy` are derived at
read time. `verifiedDeploy` requires an *enforcing* verifier rather than an
installed one, and that rule holds across both of §16's verifiers: a cluster
whose policy engine is auditing and a project whose admission policy is dry-run —
or whose evaluation mode admits everything however it enforces — both report
capable of nothing. A Cloud Run Target whose connection names no policy endpoint
reports the same, because nobody said where to look, which is the direction a
claim about verification has to fail in.

Placement is a filter, not a scheduler. Derived requirements — nothing is
authored by a developer — narrow connected Targets to candidates, the
highest-ranked one is suggested, and **non-candidates are returned listed and
annotated with why**, so "nowhere fits" is an answer rather than a deploy that
fails later.

## Build, Deploy, and the loop

A **Build** records an artifact; it never deploys one. Uploading an archive of
finished output produces a `SUCCEEDED` Build with the bundle digest naming the
artifact and **no build route consulted at all** — there is nothing to run, and
running one would produce a second digest over the same bytes. Everything else
goes through a route, and the route's name and log fidelity land on the Build so
a thin log reads as the runner it is rather than as a bug.

**Three routes, one engine.** §4 settles BuildKit with two frontends — the
repo's Dockerfile if present, else the pinned zero-config frontend — and
`src/adapters/build/buildkit.ts` is what keeps that from being three
implementations of the same idea: the cloud builder runs the program in a build
step, the cluster runs it in a Job, and the reusable workflow runs the same
ladder through buildx. The ladder itself runs *inside* the builder, because a
Dockerfile settles how to build and never what the thing is (§5) — the kind was
decided before the build was dispatched.

**The result comes back through the log**, because logs are read and never
pushed (§4). That decision has a consequence nobody states: with no ingest
endpoint there is nowhere for a runner to hand back a digest either, so the
runner prints one base64 marker line and core reads it out of the log it was
already fetching. No callback, no second channel, nothing to authenticate. What
it echoes is the bundle digest it was *handed*, and the route checks rather than
copies it — §16's join is only a check if the runner can disagree.

Each route declares a profile level and a Target sets a threshold:
`src/domain/build-route.ts` filters on the level and then takes the
highest-ranked survivor, which is §16's "the level is a threshold, then admin
rank wins" in that order. The in-cluster route is L1, so an L2 Target refuses
it however highly it is ranked — which is also why a Target cannot be both
offline-capable and require L2. `dispatchBuild` enforces the threshold half
wherever a placement is named, because refusing to start costs nothing while an
artifact built below a Target's minimum is a green build followed by an
admission failure nobody reading the build log can explain.

One half is still missing from the Target surface:
`targets.min_build_level` is read but nothing sets it, and there is no ordered
per-Target route list — both belong to the Target model and the connect act.

Every refusal `dispatchBuild` makes happens *before* the claim, so it is
returned to `runBuildPass` — which is `if (result.ok) dispatched += 1` and drops
everything else. That makes writing the refusal down the only way it reaches
anybody, and `refuseDispatch` splits them on one question: can a later tick
clear this? A fact about the row — a location no route can fetch, a name no
registry will accept, a bundle never staged — closes the Build out with §6's
reason, because retrying it once a second forever is the only alternative. A
fact about the installation — no federation, no such route, a threshold no
configured route meets — leaves the Build `PENDING`, so that configuring the
thing makes the next tick work without anybody pressing Deploy again, and
records what is being waited on. The build loop runs at 1Hz, so the sentence is
written once and suppressed against `builds.dispatch_waiting_on` until it
changes; the claim clears the column. `runBuildPass` writes the one refusal of
that class made before dispatch is reached — a Target no configured route can
serve — through the same function.

Core's supply-chain gate is verify → sign → record. It joins the source receipt
and backend envelope on the bundle digest, invokes the pinned verifier against
an immutable artifact reference, caps the achieved level by the route's
code-defined maximum, and calls the KMS-backed signer only after the Target's
current threshold passes. A failed assessment leaves no admitted artifact or
signature. Every later deploy and rollback checks the recorded level against
the Target's policy again, so a policy raise marks a serving release as drift
without stopping it and governs every new placement. The builder's unsigned
materials and SPDX references stay separate; posture calls the SBOM not
assessed and surfaces a stale base without changing it.

The hosted route normalizes a base digest from its BuildKit materials. The
cloud and in-cluster routes retain the attached materials reference but report
base freshness as unknown until their registry-attestation read path is wired.

The route adapters still return runner-account placeholders where a
verifier-compatible backend envelope belongs. The gate rejects those
fail-closed; a production build cannot become green until its backend returns
the native signed envelope the pinned verifier accepts.

The hosted route runs in the *connected* repository, on its own Actions minutes
(§15), through the thin caller the configuration PR wrote there. An uploaded
archive has no repository, so it runs where the reusable workflow lives —
which is why `.github/workflows/spindrift-build.yml` declares both
`workflow_call` and `workflow_dispatch`. A dispatch names no run, so the caller
carries a correlation input it stamps into `run-name` and the route finds its
run by that name; the correlation stays out of the spec because no part of the
build depends on it.

Repository authorization begins in `/repos` with the GitHub App Device Flow.
The installation manifest names the public client and API origins; it carries
neither a connected repository nor a GitHub credential. The resulting user
access and refresh token are one encrypted Postgres row, shared by the web and
reconciler processes. Repository rows retain only the installation identity
GitHub reports when the authorized operator selects a repository.

`SPINDRIFT_CREDENTIAL_KEYRING` is a JSON document in the installation Secret:

```json
{"active":"2026-07","keys":{"2026-07":"<32 bytes, base64url>"}}
```

Rotation is two PRs. First add a new key, make it `active`, and retain every
old key in `keys`; credential reads and refreshes rewrite legacy envelopes
under the active key while holding the singleton row lock. After the rollout
has exercised the connector, a later PR removes the legacy entries. Removing a
legacy key in the first PR makes ciphertext that has not yet been read
undecryptable, so the parser fails loudly instead of guessing.

A **Deploy** is an intent, written under `SELECT ... FOR UPDATE` on the one
`(Component, Target)` desired row. That locking read is the whole of the
concurrency design: two intents for one pair serialize, and the second reads what
the first committed rather than what preceded both. **Rollback is an ordinary
deploy** — a newer intent naming an older Build — and it asks only one extra
question, under the same lock, so it cannot become a way to place what a forward
deploy refused.

`src/reconciler/deploy-loop.ts` is what turns an intent into a workload. It
**claims with `FOR UPDATE SKIP LOCKED` and then lets the lock go**, because the
claim is the `APPLYING` phase rather than a held transaction — a lock does not
survive a reconciler restart and a phase does. Phases after that come from the
adapter and never from core's own idea of readiness, and on red the verdict's
reason, detail, and raw payload are written to the Deploy row, because cluster
events expire in about an hour and core's copy is the one that will still exist
tomorrow. **Exposure is never touched by a failure** — the previous release is
still serving. Drift is reported and never corrected: the re-converge is an
ordinary Deploy a person presses.

**The interval is adaptive and the poll is the correctness path.** Seconds while
an attempt is in flight, minutes once converged — which is also the drift
cadence, since drift is information rather than an alarm. `LISTEN/NOTIFY` can
shorten a sleep and can never be required to: a notification is lost when no
listener is connected, so every test here runs with no wake-up wired.

## Config

**Values are write-only, and the database is where that is proved.** A value
crosses one seam — `SecretStore.put` — and what comes back is a pinned
reference; nothing above the store contract has a verb that returns a value,
because the contract has none. `test/commands/config.test.ts` searches every
column of every table for the plaintext after a set, so a future shortcut that
kept one has somewhere to fail.

A Deploy records the **document** it delivers, not just its hash. That is what
makes a rollback come back up with the configuration the release originally had:
re-reading current config at apply time would give a rollback the configuration
of the release it is rolling away from. `configVersion` is the hash over that
document, canonicalized by variable name so two reads in different row order are
one version.

**A config change produces a new Deploy** of whatever is already desired at that
pair — a changed reference nothing re-applies is a workload still running the
old value. Where nothing is deployed there yet, the act says so instead of
inventing a Deploy with no Build.

**Uploads are replace-with-diff, and the diff is over keys.** Core cannot read a
value back, so it cannot tell a changed value from an identical one: the review
names what is added, what is removed, and what will be rewritten, and every key
in the upload is rewritten because "unchanged" is a claim only something that had
read the old value could make.

**Core never retrieves, therefore core cannot migrate.** Two Targets in front of
the same store of record make a re-placement free — the pinned *reference* is
carried and no value moves. Two Targets in front of different ones cannot:
`placeComponent` names the keys that will not follow and demands them before the
move commits, and `createDeploy` refuses the same move for the same reason, so
skipping Place is not a way around it.

Retention is core's, at ten versions — the same depth as artifacts, because a
shallower one makes a rollback come up green and unconfigured.
`src/reconciler/config-loop.ts` reaps on a loop; the write path reaps the key it
just touched as a fast path.

**A website is the one exception, and it is derived rather than chosen.** §10
allows it because whatever a website bakes becomes public the moment the site
is served, so the asymmetry that sends everything else to the store does not
exist there — and §4 states the payoff: build arguments are ordinary rows, so
**no builder ever holds a store credential**. `isBuildTimeConfig` takes a
Component kind and nothing else, which is what keeps the exception too narrow
for a developer to opt a credential into. Two consequences fall out of it: a
website reaches no store, so the reach rule does not apply to one, and a
website's config change produces **no Deploy** — the value was baked into the
artifact that is already serving, so re-applying it would deliver the old value
under a new `configVersion`. The new value arrives with the next build, and the
act says so.

The known limit, stated rather than worked around: configuration is scoped to
(Component, Target) while a Build is keyed on (Component, commit, target-shape),
so two Targets of the same shape wanting different website build arguments want
two artifacts the Build key cannot tell apart. `dispatchBuild` takes the
placement it is building for and the second dispatch collides on the unique key
rather than quietly serving the first one's values.

Delivery follows the Target, and both renderings carry a pinned *reference*
rather than a value because that is all core has. On a Cloud Run Target each
variable is a `secretKeyRef` the revision resolves at start from its own
project's store, over the runtime's access path rather than core's — which is
why no credential appears anywhere in that document.

On a Kubernetes Target it is the App chart's `ExternalSecret`, which
fetches each pinned reference into one Secret keyed by variable name. Two things
an installation has to supply for that to work: the operator names the
`ClusterSecretStore` in the Target's chart-values (`platform.secretStore.name`,
without which the chart refuses to render rather than producing an
ExternalSecret that never syncs), and the process needs `SPINDRIFT_STORE_TOKEN`
in its environment — the access path core writes over. A config act refuses with
that sentence when it is missing.

The cloud build route reads a second variable, `SPINDRIFT_BUILD_TOKEN`, for the
same reason and with the same posture: two access paths to two services, each
read per call so a rotated Secret takes effect without a restart. Hosted CI
uses the GitHub authorization created in the Repositories UI and encrypted in
Postgres by `SPINDRIFT_CREDENTIAL_KEYRING`; the in-cluster Job authorizes with
the projected service account token.

**A cloud Target needs no variable at all**, and that is §13's one auth mode
arriving where the spec wanted it: "native OIDC federation, nothing stored".
`src/adapters/deploy/cloud/federation.ts` reads a projected token, exchanges it
at the pool's STS endpoint, and optionally impersonates a service account.

**Nobody configures any of that.** The installer chart already renders an
`external_account` credential document from the workload-identity audience and
mount path a release names, and points `GOOGLE_APPLICATION_CREDENTIALS` at it.
`src/config/federation-credential.ts` reads the four facts back out of that
document, and `resolveManifest` joins them onto the manifest every reader gets —
so there is no `cloud.federation` key to author, and nothing that could disagree
with the pod it is running in. An installation whose deployment mounts no
credential resolves `null`, which is exactly what an installation with no cloud
Targets honestly has.

The mistake it exists to prevent is worth naming, because it is the convenient
one: **the default service account token is the wrong token.** It is minted for
this cluster's own API server, and a cloud API refuses it — the symptom would be
a `401` on every cloud deploy, blamed on the Target. So the token path is read
from the credential's `credential_source.file`, which the chart renders from the
*separately* projected volume whose audience is the pool, with no default that
could quietly be the wrong one. An installation with no federation gets a
provider that refuses with that sentence, rather than a Target that silently
cannot be assessed.

## The three deploy backends

One contract, three renderings, and **one conformance suite that every one of
them passes** (`test/conformance/`). What differs between them is not how much
of the contract they implement — it is what their backend is actually able to
be honest about.

**A cluster** is driven through its GitOps operator, as above. **Cloud Run** is
driven through the runtime's own API: `apply` writes one Service with
`allowMissing`, so create-and-update are the same call and idempotence costs
core no memory of whether it placed this before. **Static hosting** is five
calls, because the product's contract is that a version is immutable once
finalized and a release is what makes one serve — version, populate, upload,
finalize, release. The hash offered on populate is over the *gzipped* bytes,
which is what the product stores and therefore what it deduplicates on, so a
redeploy of an unchanged site uploads nothing.

**A `files` artifact is a gzipped tar**, and the static adapter reads one with
`src/adapters/deploy/static/bundle.ts` rather than a dependency: it is the same
format `buildkit.ts` already unpacks, read from the other end, and §20 wants a
package that prunes to something self-contained. The bundle is untrusted input,
so a path that escapes the bundle is refused rather than normalized away — that
would be the only path in this system by which one App could reach another's.

**The checklist a Target is assessed against is its adapter type's**, not one
list for all three (`PREREQUISITES_BY_ADAPTER`). §13's list is written in a
cluster's terms because a cluster is the backend it was written about, and a
Cloud Run Target has no delivery operator to run and no chart to pin — a row
that can never fail teaches a reader that something was checked when nothing
was. Both cloud backends answer three items from **one probe**, separated by the
shape of the refusal: a `SERVICE_DISABLED` is the API being off, a bare `403` is
the federated identity, a `404` is the vessel. Three separate calls would be
three answers that can disagree, so that a Target reads authorized against a
project that does not exist.

**A store is reachable, or the kind does not need one.** A cluster's writable
store is discovered and can genuinely be absent; a Cloud Run revision resolves
its own project's store natively; **static hosting reaches no store at all**,
because it has no runtime to resolve a reference with. That last one is why
§10's website exception matters structurally rather than only as a convenience:
placement does not apply the reach rule to a `website`, so a Target that
delivers no config still holds the one kind that asks for none. Applying it
anyway would make "picking the static Target *means* public" (§13) unreachable
by construction.

Two things stated rather than worked around:

- **Cloud Run advertises no egress filtering** (§8). It has network controls and
  not the by-name allowlist §8 specifies, and a capability reported on the
  strength of something adjacent is a workload placed somewhere its egress was
  never actually constrained.
- **`Private` has no audience on Cloud Run.** §9 gives it "one
  admin-configured Private audience per Target" and no Target carries one, so a
  `private` Component gets an empty invoker policy: reachable at its address and
  refusing everyone. Wrong in the safe direction, and it stays there until the
  authenticated edge lands — which the plan already calls the largest
  non-Spindrift dependency.

Exposure reaches the cloud runtime as two mechanisms, because the runtime
answers two separate questions: *who can route to it* is ingress, and *who may
invoke it* is IAM. Only `public` relaxes the second. §9's **transitions fail
closed**, and the ordering is where that lives: a tightening exposure writes the
invoker policy *before* the Service and again after it, so the closed state is
asserted on every deploy rather than inherited from the platform's default;
opening can only happen after, because granting invoke on something that is not
there is not a call the API takes. A public deploy whose grant fails is red, not
quietly private.

**Static hosting serves `Public` only** (§9), and a non-public Component
reaching it is refused as `INTERNAL` rather than `REJECTED` — placement already
excludes this Target for one, so one arriving is core's bug and not a
developer's.

## Naming and DNS

Two layers (§9), with different rules for a reason. **Canonical names nest**
(`web.shop.<apex>`) because they are unproxied; **vanity names are one flat
label** because a single apex's free certificate covers one subdomain level, and
that is where §9's ceiling of roughly twenty of them comes from. Core mints a
canonical name only for a cluster — Cloud Run and static hosting name their own
workloads, and there the adapter reports the address back across the deploy seam.

**Spindrift publishes no record itself, and holds no zone credential.** On a
cluster the App chart renders one `DNSEndpoint` per Component
(`packages/charts/spindrift-app/templates/dnsendpoint.yaml`), at the record type
and target `reach` decides, garbage collected with the release that owns it.
The `HTTPRoute` itself carries a controller annotation that keeps
external-dns's `gateway-httproute` source from also publishing the same
hostname off the shared gateway's own address — a route can never state its own
per-Component target, so letting both sources publish raced the same name at
two record types.

**What the objects become is asserted, not the objects.** A rendering golden is
green whenever the manifests are right, and they were right throughout the life
of the defect that split these two objects apart — the controller published
something else. `test/conformance/reach-publication.test.ts` runs a
`DesiredState` through the real adapter, renders the chart with the values that
reach the cluster, and reads the result through a model of the controller's two
sources (`test/harness/fakes/external-dns.ts`), so what is asserted is the
record rather than the document asking for it. The Target's private address and
its gateway's own address are pinned apart there: live they are equal, which is
what made a record derived from the gateway and a record the chart stated
indistinguishable.

Which sources that controller runs is the other half of the mechanism and is not
Spindrift's to declare, so it is read from `clusters/` rather than assumed
(`test/harness/external-dns-installation.ts`), once for every cluster a
Component can be placed on. A sources list that loses `crd` is a `DNSEndpoint`
nobody reads while every route is still held out — no source claims the name and
`--policy=sync` deletes the record — with each rendered object still exactly
right. Any argument that model does not account for fails there rather than
being approximated.

The live-from-creation status name and a vanity leg standing in front of a
backend that cannot carry the name itself still have no `DNSEndpoint` to
render, because both need a name before any Component exists to hang one on.
`test/extraction/no-dns-credential.test.ts` is the grep that keeps "no zone
credential" true, and it also asserts DNS is still being described somewhere, so
the negative claim cannot be satisfied by there being no DNS at all.

**Proxying is a per-Target property**, and §9's sentence makes it one with the
causality running the opposite way to how it reads: "the vanity record is
unproxied on that leg, **so** proxying becomes a per-Target property." The proxy
is not a preference — it is the only way a name reaches a metal cluster at all,
because the cluster's load-balancer range is RFC1918 and public reach goes
through the tunnel. A backend that answers on the public internet by itself
needs no such hop. So `vanityProxied` is derived from the adapter type, which
*is* a per-Target property because a Target has exactly one (§13), and storing
it would let an operator assert something the backend contradicts.

The unproxied leg costs something, and §9 absorbs it on purpose:
`VANITY_LEG_LOSSES` says the leg buffers the whole response, so **WebSockets and
SSE die there and requests cap at sixty seconds**. Two-layer naming is what
makes that absorbable — the app stays fully capable at its canonical name — so
the answer is to **state** them, never to work around them. A workaround would
be a second edge, which is the external load balancer §9 declines to have.
`VANITY_CEILING` is the same kind of fact: roughly twenty is a property of one
apex's certificate, so `vanityRation` counts and nothing refuses the
twenty-first.

**Both are values with no reader yet.** The rules are here and tested; the
screens that state them are Milestone 8, and nothing counts minted names, so
`vanityRation` is only ever asked about a number a caller supplies. They are
here rather than later because the leg they describe exists now and the rule is
what an adapter would otherwise each invent.

On a static Target the vanity name is a **domain on the site that is already
serving**, which is what makes §9's "moving an App between backends is one
record re-point" true there rather than aspirational: the name is a function of
the label and the zone alone, so a move changes what is underneath it and never
what anyone bookmarked.

**The non-metal vanity leg itself is not built.** §9 closes it with "the same
site with a zero-file version carrying a rewrite", which is what a *Cloud Run*
Component's vanity name would need — and the Cloud Run adapter reads no
hostname at all, because there the platform names its own and the canonical
comes back across the seam. So an App on Cloud Run with a vanity label has a
name nothing serves. The static path above is the case where the name lands on
the site that already holds the files; the leg in front of another backend
wants the same `DNSEndpoint` machinery the status name does, and it waits with
it.

One name is contended and one is not. The canonical is per Component, so it
never collides. The **vanity name is per App**, so an App with two
network-serving Components has one name and two claimants — it goes to a sole
serving Component and otherwise to none, because putting one hostname on two
routes lets the platform pick a winner arbitrarily. Which Component is the front
door is the developer's to say, and there is nowhere to say it yet.

## Testing

Tests run against a real Postgres — the concurrency design is a claim about
transactions, and a fake cannot falsify it.

**On WSL, `wslc.exe` containers are not reachable from this distro.** They run in
their own WSL VM, so `--publish` binds a port in *that* VM's namespace: the
container is healthy (`wslc.exe exec <name> pg_isready -U postgres` succeeds) and
nothing in this distro can connect to it. The symptom is every database test
failing on a `beforeEach` hook timeout, which reads like a code bug and is not
one. Run Postgres natively instead:

```bash
## WSL — native, because a published container port does not reach this distro
nix shell nixpkgs#postgresql_16 -c bash -c '
  initdb -D /tmp/spg-data -U postgres --auth=trust &&
  pg_ctl -D /tmp/spg-data -l /tmp/spg-data/log \
    -o "-p 15432 -c listen_addresses=127.0.0.1 -c fsync=off" start &&
  createdb -h 127.0.0.1 -p 15432 -U postgres spindrift'

DATABASE_URL=postgres://postgres@127.0.0.1:15432/spindrift bun test
```

On macOS, and anywhere a container's published port is genuinely reachable, a
container is fine:

```bash
docker run --detach --name spindrift-postgres \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD=postgres \
  --env POSTGRES_DB=spindrift \
  --publish 127.0.0.1:5432:5432 \
  postgres:18-alpine
```

and `DATABASE_URL` points at it:

```bash
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/spindrift bun test
```

`test/harness/db.ts` gives every test its own migrated Postgres schema, so tests
never see each other's rows. Adapters are faked only at the contract —
**fake the far side, never our side** — and `test/conformance/adapter-suite.ts`
is one suite every adapter implementation must pass. Adding an adapter without
enrolling it in that suite fails a test that names it.

## The installation manifest

Every value that names a particular installation lives in one document —
`src/config/manifest.schema.ts` defines it, `test/fixtures/installation.example.yaml`
is a complete one for an installation that does not exist. A literal outside
that document is a bug, and `test/extraction/no-literals.test.ts` is what
notices.

It has two scanners with different reach. The **literal** scanner — the half
with teeth, which knows the words that name this installation — reads every file
under `src/`. The **project-id shape** scanner skips `src/web/`: web platform
vocabulary is lowercase hyphenated words, and so is a project id, so over a
browser bundle it reports dozens of findings and no bugs. The test says so at
length, and the exemption is itself tested.

The validated manifest is durable in Spindrift's Postgres database. Point a
process at its deployment declaration:

```bash
export SPINDRIFT_MANIFEST_PATH=test/fixtures/installation.example.yaml
# or, inline:
export SPINDRIFT_MANIFEST="$(cat test/fixtures/installation.example.yaml)"
```

A process validates and reconciles the declared document into the singleton row
before constructing adapters. A process with no declaration recovers the last
validated value from Postgres. Boot fails loudly, naming every offending key,
when a declaration or stored document is invalid, or when both are absent.
Target connection facts in the document are desired state; omitting them leaves
an in-product connection untouched. Nothing has a default, because a default
here would name someone's homelab. The two vessels
`installation.controlPlaneVessel` and `installation.homeVessel` name are the one
exception to seeds-but-does-not-govern, for the reason above.

A document written under an older schema is brought forward rather than
discarded — `src/config/manifest-upgrade.ts`, run inside validation, because a
row this build cannot parse is a row it treats as unseeded and re-seeds over.
`test/fixtures/stored-manifests/` holds one frozen snapshot per shape a stored
document has ever had and every one of them has to boot; the newest must need no
upgrade at all, which is what makes the next schema change prove itself.

## Usage

```bash
bun install                             # once, at repo root (workspace member)
bun run --cwd apps/spindrift build      # client → dist/
bun run --cwd apps/spindrift test       # bun test
bun run --cwd apps/spindrift typecheck  # tsc --noEmit

# The UI, compiled on demand — no build step, hot reload.
SPINDRIFT_MANIFEST_PATH=test/fixtures/installation.example.yaml \
  bun run --cwd apps/spindrift dev      # http://localhost:3000

# What the image runs: serves dist/, so `build` has to have happened.
SPINDRIFT_MANIFEST_PATH=test/fixtures/installation.example.yaml \
  bun run --cwd apps/spindrift start

# The second process in the same image.
SPINDRIFT_MANIFEST_PATH=test/fixtures/installation.example.yaml \
  bun run --cwd apps/spindrift src/reconciler/main.ts
```

`mise run ts:check` typechecks and lints the whole workspace, this package
included.
