/**
 * The installation manifest: every value that names a particular installation
 * of Spindrift.
 *
 * Spec §20, line 3 — "everything naming this installation is a value in the
 * installation manifest; a literal outside it is a bug". That rule is
 * mechanical: `test/extraction/no-literals.test.ts` greps `src/` for
 * installation-specific literals, so nothing in this file may carry an example
 * value from the installation that happens to run it.
 *
 * There are no defaults. A missing key fails the boot rather than falling back
 * to whatever the first operator happened to use.
 *
 * **What names the installation and what names its deployment are not the same
 * set.** A value the installer chart already renders is read from the
 * deployment, never asked for here as well: a fact carried in both places
 * satisfies §20's grep and can still disagree with itself, and a disagreement
 * surfaces somewhere else entirely — once as an `iam.serviceAccounts.signBlob`
 * refusal that read as a code defect. Every removal is recorded at the block it
 * left, so the reason survives the key.
 */
import { z } from 'zod';
import type { FederationConfig } from '../adapters/deploy/cloud/federation.ts';

/** A non-empty string with no surrounding whitespace. */
const nonEmptyString = z.string().trim().min(1);

/**
 * A Target or Vessel identifier accepted by both the manifest and the connect
 * act.
 *
 * One spelling for both nouns because a Target name and a Vessel name land in
 * the same places — a DNS-shaped label in a URL path and a column with a unique
 * index — and two regexes that had to agree would be two regexes that could
 * disagree.
 */
export const targetNameSchema = nonEmptyString
  .max(63)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    'must be lowercase letters, digits and hyphens',
  );

/** A DNS zone apex, e.g. `apps.example.test` or `localhost`. */
const zone = nonEmptyString.regex(
  /^(localhost|(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+)$/,
  'must be a lowercase DNS name or localhost',
);

/** A trusted HTTP request header configured by the front-door Gateway. */
const headerName = nonEmptyString.regex(
  /^[A-Za-z0-9-]+$/,
  'must be an HTTP header name',
);

/**
 * The optional authenticated-Gateway adapter.
 *
 * The Gateway owns the provider protocol and presents a normalized subject to
 * Spindrift over a non-bypassable hop. `adapterKey` distinguishes two Gateway
 * configurations that happen to use the same issuer and subject.
 */
export const gatewayAuthSchema = z
  .object({
    adapterKey: nonEmptyString,
    issuer: z.string().url(),
    subjectHeader: headerName,
    displayNameHeader: headerName.optional(),
  })
  .strict();

/**
 * The delivery adapter a Target speaks (§6). One Target has exactly one
 * adapter type, because placement determines artifact shape (§13).
 */
export const targetAdapterSchema = z.enum([
  'kubernetes',
  'cloudrun',
  'static',
  'vercel',
  'cloudflare-pages',
]);

/**
 * The secret store this installation resolves the reach rule with (§10, §20).
 * v1 ships two so the pluggability claim is falsifiable.
 */
export const storeAdapterSchema = z.enum(['onepassword', 'gcp-secret-manager']);

/**
 * Which of §4's three build routes a configured route is one of.
 *
 * The *kind* is a closed vocabulary because each one is a different piece of
 * code; the *set of routes an installation has* is not, which is why `routes`
 * below is a list an operator writes rather than one of these three per
 * installation. §4: "which routes exist is an installation's configuration."
 */
import {
  buildRouteAdapterSchema,
  buildRouteSchema,
} from './build-route-schemas.ts';

export { buildRouteAdapterSchema, buildRouteSchema };

const kubernetesDeliverySchema = z.discriminatedUnion('flavour', [
  z
    .object({
      flavour: z.literal('flux-helmrelease'),
      namespace: nonEmptyString,
      sourceRef: z
        .object({
          name: nonEmptyString,
          namespace: nonEmptyString,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      flavour: z.literal('argo-application'),
      namespace: nonEmptyString,
      project: nonEmptyString,
      repoUrl: nonEmptyString,
      revision: nonEmptyString,
      server: nonEmptyString,
    })
    .strict(),
]);

const reachSchema = z.enum(['none', 'private', 'public']);

/**
 * The facts every kind of vessel states about itself, whatever it is.
 *
 * Both are properties of the **boundary** — of the network a cluster or a
 * project sits on — so they are true for every surface on it and impossible for
 * two of those surfaces to disagree about. That is the whole reason they are
 * here rather than on a Target: `src/domain/vessel.ts` records what it cost
 * when they were stated per surface.
 *
 * Optional rather than defaulted, matching the row: absent means unstated, and
 * `[]` means stated-and-empty. A Target with no declared `reachableRegistries`
 * gets the first of `supplyChain.registry`, which is not the same answer as one
 * that reaches none.
 */
/**
 * The installation-wide services one vessel holds for every other.
 *
 * These were four unrelated top-level keys — `sources.defaultBucket`,
 * `cloud.artifactsProject`, `secretStore.container` and
 * `cloud.homeVesselProject` — that happened to describe one boundary. Nothing
 * said they had to, so nothing noticed when they stopped: a bucket in one
 * project, a store in another and a `homeVesselProject` naming a third is a
 * document that validates and then fails at the first signed URL.
 *
 * Stated on the vessel they are one boundary's properties, and the fourth
 * collapses entirely — where the home vessel *is* is its `location`, which every
 * vessel already carries and which two keys can no longer disagree about.
 *
 * Only the vessel `installation.homeVessel` names may carry this block, and it
 * must: the document-level refinement below enforces both halves, so a reader
 * asking for the source bucket resolves exactly one answer.
 */
export const sharedServicesSchema = z
  .object({
    /** Where archive sources and artifacts are staged before a build (§4). */
    sourceBucket: nonEmptyString,
    /**
     * Project holding immutable build artifacts and signing material, shared
     * across every vessel (§14). Its own project rather than this vessel's: an
     * installation may publish artifacts from a project it runs nothing in, and
     * this one does.
     */
    artifactsProject: nonEmptyString,
    /**
     * What holds the items inside the secret store: the vessel's project for
     * Secret Manager, the vault for 1Password.
     *
     * One key rather than one per adapter, because the two are the same thing
     * under different names, and a per-adapter block would let an installation
     * configure a store it does not use.
     */
    secretStoreContainer: nonEmptyString,
  })
  .strict();

/**
 * A repository-relative directory, checked the way §5's named scope is: no
 * leading slash and no traversal, and nothing said about the tree's layout.
 *
 * The layout is the installation's, not this software's — an installation whose
 * roots live somewhere else is not misconfigured — so the only thing enforced is
 * that the path stays inside the repository it is resolved against.
 */
const repositoryPath = nonEmptyString.refine(
  (value) => !value.startsWith('/') && !value.split(/[\\/]/).includes('..'),
  'must stay inside the repository',
);

const vesselFacts = {
  name: targetNameSchema,
  servedHosts: z.array(nonEmptyString).optional(),
  reachableRegistries: z.array(nonEmptyString).optional(),
  shared: sharedServicesSchema.optional(),
  /**
   * Where this boundary is declared in the infrastructure repository, as a
   * directory relative to its root.
   *
   * What a generated remediation is *for*: §13's checklist states what is unmet
   * and `domain/remediation.ts` states the Terraform that clears it, and a
   * stanza with nowhere to go is a snippet. Declared here rather than derived
   * from a naming convention, because a convention would let this software
   * invent a path nothing in that repository has ever agreed to — and then
   * open a pull request against it.
   *
   * Optional, and its absence is the honest answer rather than a gap: a
   * boundary somebody connected through the UI genuinely has no root, and the
   * remediation for it says exactly that instead of naming a directory.
   */
  terraformRoot: repositoryPath.optional(),
};

/**
 * A Vessel declared by installation desired state — §13's tenancy boundary,
 * named rather than spelled as a shared prefix of two Target names.
 *
 * Discriminated on `kind` for the reason `VesselLocation` is: a `cluster` with
 * a project id is not a state the domain has a name for, and the location's
 * shape follows from the kind rather than being a bag of optional keys beside
 * it. The `kind` inside {@link VesselLocation} is therefore not restated here —
 * it is this key, and a document that carried both could carry two answers.
 *
 * `location` is optional for exactly the reason the column is nullable: a
 * declaration may seed a boundary's identity and rank without stating how to
 * reach it, leaving the connect act to supply that. A Target is addressable
 * when its own connection **and** its vessel's location are both present.
 */
export const vesselSeedSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...vesselFacts,
      kind: z.literal('cluster'),
      location: z
        .object({
          /** §13's prerequisite is OIDC against this endpoint. */
          apiServer: z.url(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      ...vesselFacts,
      kind: z.literal('gcp-project'),
      location: z
        .object({
          /** The project every surface on this vessel deploys into (§14). */
          project: nonEmptyString,
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      ...vesselFacts,
      kind: z.literal('vercel-team'),
      location: z
        .object({
          /**
           * The team or account every surface on this vessel deploys into.
           *
           * A slug or a `team_…` id: the API takes either under `teamId`, and
           * an operator reads the slug off the dashboard URL.
           */
          team: nonEmptyString,
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      ...vesselFacts,
      kind: z.literal('cloudflare-account'),
      location: z
        .object({
          /** The account every surface on this vessel deploys into. */
          account: nonEmptyString,
        })
        .strict()
        .optional(),
    })
    .strict(),
]);

/**
 * A Target declared by installation desired state.
 *
 * Connection facts are optional so an operator may still seed an identity and
 * connect it through the product. When supplied, they are ordinary,
 * credential-free platform configuration and make the connection reproducible
 * from Git.
 *
 * **Only facts true of this runtime surface and not of its neighbours.** Where
 * the boundary is, and what it can reach, are declared once on the vessel this
 * names.
 *
 * **There is no `name`.** `vessel` and `adapter` are what identify a Target, so
 * a third field could only restate them or contradict them — and the spelling it
 * used to carry was a suffix that appeared only where a vessel had two surfaces,
 * which made the day a vessel gained one a day the other had to be renamed.
 */
export const targetSeedSchema = z.discriminatedUnion('adapter', [
  z
    .object({
      /** The vessel this Target is a surface on, by name (§13). */
      vessel: targetNameSchema,
      adapter: z.literal('kubernetes'),
      /**
       * §3's asserted half, declared so a torn-down installation comes back
       * knowing what it can serve rather than waiting for someone to re-state
       * it. Absent means unasserted, which is not the same as `[]`.
       */
      reaches: z.array(reachSchema).optional(),
      authReaches: z.array(reachSchema).optional(),
      connection: z
        .object({
          namespace: nonEmptyString,
          delivery: kubernetesDeliverySchema,
          logHistorySeconds: z.number().int().nonnegative().optional(),
          /**
           * §7's operator class, verbatim. Untyped for the reason
           * `KubernetesConnection.chartValues` gives: the chart's classes are
           * the adapter's knowledge, and the boundary is enforced where this is
           * saved rather than where it is declared.
           */
          chartValues: z.record(z.string(), z.unknown()).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      vessel: targetNameSchema,
      adapter: z.literal('cloudrun'),
      connection: z
        .object({
          region: nonEmptyString,
          endpoint: z.url(),
          policyEndpoint: z.url().optional(),
          /** The identity a revision runs as. See `CloudRunConnection`. */
          serviceAccount: nonEmptyString.optional(),
          logHistorySeconds: z.number().int().nonnegative().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      vessel: targetNameSchema,
      adapter: z.literal('static'),
      connection: z
        .object({
          endpoint: z.url(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      vessel: targetNameSchema,
      adapter: z.literal('vercel'),
      connection: z
        .object({
          endpoint: z.url(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      vessel: targetNameSchema,
      adapter: z.literal('cloudflare-pages'),
      connection: z
        .object({
          endpoint: z.url(),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);

export const installationManifestSchema = z
  .object({
    /**
     * What this installation is, and which two vessels it is built on.
     *
     * The two pointers are scalars naming a declared vessel, and cardinality
     * comes free with that: a field that names one vessel has nothing to
     * constrain, no partial unique index, and no guard that can drift from the
     * column it guards. An `is_home boolean` could express neither — it would be
     * true of two rows and say nothing about which.
     *
     * "This vessel is undeletable" then stops being a column and becomes
     * *something points at it*, which is the check `targets`' `restrict` already
     * performs one noun down. Neither pointer is a foreign key, so the guard is
     * explicit in the command paths rather than in the schema — see
     * `disconnectTarget`.
     */
    installation: z
      .object({
        /**
         * Opaque label for this installation. Appears in the UI and in logs; it
         * carries no behaviour.
         */
        name: nonEmptyString,
        /**
         * The vessel this control plane runs on (§19).
         *
         * Being *also* an ordinary deploy Target is fine and needs no marking:
         * it is the in-cluster destination, first in `targets` and rank 0, and
         * an ordinary destination besides.
         */
        controlPlaneVessel: targetNameSchema,
        /**
         * The vessel holding this installation's shared services — the source
         * bucket, the secret store, the artifacts project and the signer.
         *
         * Where the installer put them, so it is an install-time fact rather
         * than an operator choice; there is no act that moves it.
         */
        homeVessel: targetNameSchema,
      })
      .strict(),

    controlPlane: z
      .object({
        /**
         * Where this control plane's own UI is served.
         *
         * Two things read it and both genuinely need it. A passkey is scoped to
         * a **relying party id**, which is this name, and a ceremony performed
         * against any other origin is refused (Task 37) — so an installation
         * that guessed this wrong could enrol nobody. And the status page
         * (§9) has to tell its own address apart from an App's, which is the
         * only way one process can serve both.
         *
         * It is not derived from `dns.zones`: the control plane is a
         * platform workload (§19) and never one of its own Apps, so it does not
         * live in the zone Apps are named in.
         *
         * **Authored, even though the installer chart has a `hostname` value
         * that renders the Gateway and the HTTPRoute.** That looks like the
         * same fact restated, and it is not, for two reasons.
         *
         * The chart's `hostname` may be empty, and the chart says so: an
         * installation that renders no Gateway and no HTTPRoute, reachable only
         * in-cluster, is supported. That installation still needs a relying
         * party id, so the chart is not a total source for this and deriving it
         * would make a supported installation unconfigurable.
         *
         * And the relying party is bound once, at boot, on purpose — a passkey
         * ceremony is scoped to the origin it began at, so re-resolving this
         * mid-session invalidates credentials rather than updating them.
         * Moving where it resolves from changes which origin ceremonies are
         * accepted, and the only honest proof of that change is a real
         * enrolment, not an argument. So the chart refuses instead: a release
         * that declares a manifest whose `controlPlane.hostname` disagrees with
         * its own `hostname` fails to render, which is the earliest moment the
         * two can be compared and the only one where being wrong costs nothing.
         */
        hostname: zone,
      })
      .strict(),

    auth: z
      .object({
        /**
         * Null means passkeys are the only authentication path. A configured
         * Gateway is additive: its assertions authenticate only after an
         * operator links one from a fresh passkey-authenticated session.
         */
        gateway: gatewayAuthSchema.nullable(),
      })
      .strict(),

    dns: z
      .object({
        /**
         * The zones this installation mints names in, each stating what it is
         * able to serve (§9).
         *
         * **A list rather than a zone named per reach, and the inversion is the
         * point.** Naming a zone per reach made two the maximum an installation
         * could have, and made "which zone" a question only reach could answer.
         * An installation with a domain that exists solely to answer on the
         * internet had nowhere to say so, and an App had no way to ask for one
         * domain over another.
         *
         * Both readings the old shape had are still expressible, and the choice
         * is the installation's rather than the product's. Point every zone at
         * both reaches and flipping a Component's reach is a record re-point
         * with a stable hostname; state a zone per reach — separate trust
         * boundaries, split-horizon resolvers — and changing reach is a rename.
         *
         * **Order is the default.** An App that pins no zone mints in the first
         * one here that serves its reach, so the list's head is what an
         * installation gets by not choosing. Every zone is expected to be
         * dedicated to generated names and disjoint from any hand-managed flat
         * space; nothing here can check that, and an installation that mints
         * into a zone it also hand-manages owns the collision.
         */
        zones: z
          .array(
            z
              .object({
                name: zone,
                /**
                 * What this zone answers on. `none` is not a member: nothing
                 * routes to a Component that has it, so there is no record for
                 * a zone to publish.
                 */
                reaches: z.array(z.enum(['private', 'public'])).min(1),
              })
              .strict(),
          )
          .min(1),
      })
      .strict(),

    sources: z
      .object({
        /**
         * First-party GCS buckets for staging archive sources and artifacts (§4, §13).
         *
         * **No `defaultBucket` beside it.** Which of them staging picks is a
         * property of the home vessel — `shared.sourceBucket` — because a
         * default stated here could name a bucket in a project nothing else in
         * this document mentions.
         */
        buckets: z.array(nonEmptyString).min(1),
      })
      .strict(),

    /**
     * **No `cloud` block at all, and that is now the whole of it.**
     *
     * §13's one auth mode — "native OIDC federation, nothing stored" — is an
     * `external_account` credential document, and the installer chart already
     * writes one from the workload-identity audience and mount path a release
     * names. Asking for the same four facts here made a second copy, by hand,
     * in a document the chart does not render; the two could disagree, they
     * did, and the failure arrived as a `signBlob` refusal that read as a code
     * defect. The two keys that stayed — `artifactsProject` and
     * `homeVesselProject` — are properties of the vessel `installation.homeVessel`
     * names, so the block has nothing authored left in it.
     *
     * `cloud.federation` is resolved from the mounted credential —
     * `federation-credential.ts` — and appears on {@link InstallationManifest}
     * without ever being authored.
     */

    charts: z
      .object({
        /**
         * Reference to the App chart (§7) — the chart every deployed Component
         * renders through.
         *
         * Authored, because no deployment renders it: the installer chart names
         * itself and its own release, never the chart an App is deployed
         * through, so there is no second copy for this one to disagree with.
         * It is also a real
         * installation choice — §7 wants the App chart pinned per Target, and
         * an OCI reference is where that ends up.
         */
        app: nonEmptyString,
        /**
         * **No `installer` key.** It would name the chart this installation is
         * installed from — the release restating itself into a document the
         * release does not render — and nothing in the process reads it. A
         * value that can only be wrong is not configuration.
         */
      })
      .strict(),

    supplyChain: z
      .object({
        /**
         * The registries every artifact is pushed to and pulled from (§16).
         * Named here rather than derived from the artifacts project because a
         * mirror in front of one is a legitimate installation choice, and
         * `offlineDeploy` (§3, §33) is derived from which host the first names.
         *
         * **Several, because two Targets on one installation cannot always
         * share one.** §16 named a single registry and a placement filter over
         * it, which has no answer for an installation whose cluster pulls
         * anonymously from GitHub Container Registry while its Cloud Run
         * Target pulls through a cache mirror that cannot parse what was
         * pushed there. Each is pushed to; each Target pins the one it can
         * reach (`artifactAddress`).
         *
         * A bare string is the same document as a one-element list and stays
         * legal, so an installation with one registry says one thing and no
         * stored manifest needs rewriting to keep parsing. Order is meaningful
         * only as a tie-break: the first is what a Target with no declared
         * `reachableRegistries` gets, which is every Target until an operator
         * says otherwise.
         */
        registry: z
          .union([nonEmptyString, z.array(nonEmptyString).min(1)])
          .transform((value) => (typeof value === 'string' ? [value] : value)),
        /**
         * Where signature verification fetches its material (§16) — the third
         * of the deploy path's references `offlineDeploy` is checked over.
         */
        verifier: nonEmptyString,
        /**
         * KMS key URI core hands to cosign (§16). It is a reference, not key
         * material; the process authenticates through its workload identity.
         */
        signer: nonEmptyString,
        /**
         * The attestation authority a cloud Target's Binary Authorization
         * asks, as `projects/<project>/attestors/<name>`.
         *
         * Optional because not every installation has a cloud Target with an
         * enforcing admission policy, and naming an authority that nothing
         * consults would be configuration with no effect. Where a cloud
         * Target *does* enforce, an artifact with no attestation is refused
         * at deploy time however well signed it is: the two boundaries want
         * different objects made with the same key, and one cannot be derived
         * from the other.
         */
        attestor: nonEmptyString.optional(),
      })
      .strict(),

    github: z
      .object({
        /**
         * Public OAuth client id of that App.
         *
         * Device Flow needs no client secret or App signing key. This value is
         * safe to render into the installation ConfigMap and is what binds the
         * browser-mediated authorization to the selected-repository App.
         */
        clientId: nonEmptyString,
        /**
         * Web host carrying GitHub's Device Flow and token endpoints.
         *
         * Separate from `apiBaseUrl` for GitHub Enterprise installations,
         * whose web and REST origins differ.
         */
        oauthBaseUrl: z
          .url()
          .refine((value) => !value.endsWith('/'), 'must not end with a slash'),
        /**
         * Base URL of the repository host's REST API, without a trailing
         * slash.
         *
         * A value rather than a constant because an installation running
         * against a self-hosted enterprise deployment reaches its own host, and
         * §20 puts anything that names one installation's world here. The
         * public host is a legitimate value for it; it is not a default,
         * because there are none.
         */
        apiBaseUrl: z
          .url()
          .refine((value) => !value.endsWith('/'), 'must not end with a slash'),
        /**
         * The reusable build workflow the configuration PR's one caller calls
         * (§15), as `owner/repo/.github/workflows/<file>@<ref>`.
         *
         * **The ref may move, and that is a named trade.** §15 gives the
         * connected repository the Actions minutes and the billing, which
         * means the workflow runs with that repository's own permissions — so
         * whoever can move the ref runs arbitrary steps in every connected
         * repository at once. A branch ref hands that power to the platform
         * repository's own merge gate, and buys the fleet its currency: the
         * caller written into each connected repository tracks the platform's
         * present workflow instead of freezing at whatever commit was current
         * when that repository connected — a freeze nothing walks back,
         * because no fleet re-pin exists. An installation that wants the
         * freeze anyway states a commit sha; the schema takes either.
         *
         * Nullable, stated the way `auth.gateway` is: an installation that has
         * not published a reusable workflow yet has no honest value to put here,
         * and a placeholder would be a configuration that looks complete
         * and fails at the first build. Null means repositories cannot be
         * connected — `connectRepository` says so — and nothing else changes.
         */
        buildWorkflow: nonEmptyString
          .regex(
            /^[^/@\s]+\/[^/@\s]+\/\.github\/workflows\/[^@\s]+@\S+$/,
            'must be owner/repo/.github/workflows/<file>@<ref>',
          )
          .nullable(),
        /**
         * The repository holding this installation's infrastructure, as
         * `owner/name` — where a generated remediation is opened as a pull
         * request.
         *
         * Not the connected-repository set: those are somebody's applications,
         * and a change to a boundary belongs where the boundary is declared.
         * One key rather than one per vessel because the roots the vessels
         * point at are directories inside it.
         *
         * Optional, with the same posture `buildWorkflow`'s null has: an
         * installation whose infrastructure this host cannot reach has no
         * honest value to put here, and a placeholder would be a pull request
         * opened against a repository nobody reviews. Absent means a
         * remediation is rendered and copied rather than opened, and nothing
         * else changes.
         */
        infrastructureRepository: nonEmptyString
          .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, 'must be owner/name')
          .optional(),
      })
      .strict(),

    build: z
      .object({
        /**
         * Every build route this installation has, **in admin rank order**
         * (§16: "an ordered list of build routes... the level is a threshold,
         * then admin rank wins"). The order of this array is the rank.
         *
         * May be empty. An installation with no route can still deploy an
         * uploaded archive of finished output, because a supplied artifact
         * consults no route at all (§4) — so an empty list is a supported
         * installation rather than a misconfiguration.
         */
        routes: z
          .array(buildRouteSchema)
          .refine(
            (routes) =>
              new Set(routes.map((r) => r.name)).size === routes.length,
            'build route names must be unique',
          ),
        /**
         * The zero-config BuildKit frontend, pinned by the installation (§4:
         * "one engine, two frontends — the repo's Dockerfile if present, else
         * a zero-config builder").
         *
         * A value rather than a constant because it is an image every build
         * this installation runs pulls and trusts, so which one — and pinned to
         * which digest — is the operator's call, not the software's.
         */
        zeroConfigFrontend: nonEmptyString,
      })
      .strict(),

    secretStore: z
      .object({
        /** Which store adapter this installation delivers config through. */
        adapter: storeAdapterSchema,
        /**
         * The access path core writes over — §10's "store of record plus one or
         * more access paths", named as the one this process reaches.
         *
         * Core's path, not a Target's: the platform's own secret operator
         * fetches from the same store of record over its own path, and neither
         * needs to know the other's.
         */
        endpoint: z.string().url(),
        /**
         * **No `container` here.** What holds the items is a property of the
         * boundary they live in, so it is `shared.secretStoreContainer` on the
         * home vessel — the same place the source bucket and the artifacts
         * project moved to, and for the same reason.
         */
      })
      .strict(),

    /**
     * The tenancy boundaries this installation deploys into (§13, §14).
     *
     * Declared rather than derived. Before this key existed, a vessel was
     * spelled as the shared prefix of `<name>-cloudrun` and `<name>-static`,
     * enforced here by a rule that made a naming convention load-bearing and
     * left the boundary's own facts — where it is, what it can reach — stated
     * twice, once per surface, where the two could disagree. Naming it is what
     * makes the next backend additive: every one worth adding is a boundary
     * hosting several runtimes, so the convention would only get more
     * load-bearing, never less.
     *
     * A vessel states where the boundary is and what it can reach. It does not
     * state which surfaces are on it — those are the `targets[]` entries that
     * name it, and what a boundary really carries is established by probing it
     * at connect.
     */
    vessels: z
      .array(vesselSeedSchema)
      .min(1)
      .refine(
        (vessels) =>
          new Set(vessels.map((v) => v.name)).size === vessels.length,
        'vessel names must be unique',
      ),

    /**
     * Targets in rank order. A Target with connection facts is reconciled as
     * connected; one without them exists for an operator to connect in-product.
     * Rank is one global ordered list (§13), so array order is placement order.
     */
    targets: z
      .array(targetSeedSchema)
      .min(1)
      .refine(
        (targets) =>
          new Set(targets.map((t) => `${t.vessel}/${t.adapter}`)).size ===
          targets.length,
        'a vessel carries one surface of each kind',
      ),
  })
  .strict()
  /**
   * Every Target names a vessel this document declares.
   *
   * At the document level rather than on `targets`, because it is the one rule
   * in this schema that reads two keys at once. It replaces the
   * `<name>-cloudrun` / `<name>-static` pairing rule, and it is a stronger
   * check than that one was: the pairing rule could only say that two names
   * looked related, while this one refuses a reference that does not resolve —
   * which is what `reconcileManifestTargets` needs, since it looks a vessel up
   * by name and has nothing honest to do with a Target whose boundary is not
   * in the document.
   *
   * **It asks whether this vessel declares this surface, not whether its kind
   * carries the adapter.** A `targets[]` entry *is* the declaration — the
   * uniqueness refine above is what keeps a vessel from declaring the same
   * surface twice — and which runtimes a boundary actually has is established
   * by probing it at connect. Holding the document to a table of surfaces per
   * kind would refuse a project that genuinely runs a cluster, and would do it
   * on the authority of a value whose only job is the shape of `location`.
   */
  .superRefine((manifest, context) => {
    const declared = new Set(manifest.vessels.map((vessel) => vessel.name));
    manifest.targets.forEach((target, index) => {
      if (declared.has(target.vessel)) return;
      context.addIssue({
        code: 'custom',
        path: ['targets', index, 'vessel'],
        message: `no vessel named ${target.vessel} is declared`,
      });
    });

    // The two the installation itself is built on, resolved the same way a
    // Target's `vessel` is. A pointer that does not resolve is the one shape of
    // this document that cannot boot: the home vessel is where the source
    // bucket, the store and the signer are read from, and nothing below can
    // pick a fallback that would not be a guess about somebody's cloud.
    for (const key of ['controlPlaneVessel', 'homeVessel'] as const) {
      if (declared.has(manifest.installation[key])) continue;
      context.addIssue({
        code: 'custom',
        path: ['installation', key],
        message: `no vessel named ${manifest.installation[key]} is declared`,
      });
    }

    // Exactly one vessel carries the shared services, and it is the one the
    // pointer names. Both halves, because either alone leaves a reader with a
    // question: none declared is a source bucket nobody stated, and a second
    // one declared is two answers to `sourceBucket` with nothing to choose
    // between them.
    manifest.vessels.forEach((vessel, index) => {
      const isHome = vessel.name === manifest.installation.homeVessel;
      if (isHome && vessel.shared === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['vessels', index, 'shared'],
          message: `${vessel.name} is this installation's home vessel and must declare its shared services`,
        });
      }
      if (!isHome && vessel.shared !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['vessels', index, 'shared'],
          message: `only ${manifest.installation.homeVessel}, this installation's home vessel, may declare shared services`,
        });
      }
    });
  });

export type TargetAdapter = z.infer<typeof targetAdapterSchema>;
export type StoreAdapter = z.infer<typeof storeAdapterSchema>;
export type BuildRouteAdapter = z.infer<typeof buildRouteAdapterSchema>;
export type BuildRouteConfig = z.infer<typeof buildRouteSchema>;
export type TargetSeed = z.infer<typeof targetSeedSchema>;
export type VesselSeed = z.infer<typeof vesselSeedSchema>;
export type SharedServices = z.infer<typeof sharedServicesSchema>;
export type GatewayAuthConfig = z.infer<typeof gatewayAuthSchema>;

/**
 * The manifest as it is authored, stored and edited — exactly the schema above.
 *
 * This is what a declaration carries, what the durable row holds, and what
 * `configureInstallation` accepts. It carries no derived key, so a write can
 * never persist a copy of something the deployment already declares.
 */
export type AuthoredManifest = z.infer<typeof installationManifestSchema>;

/**
 * The authored document plus the deployment facts resolved around it.
 *
 * What every reader in the process is given. The split exists so that "what an
 * operator may write" and "what the software may read" are different types: a
 * derived value is present for readers and unreachable from any write path,
 * which is what makes disagreement impossible rather than merely discouraged.
 */
export type InstallationManifest = AuthoredManifest & {
  readonly cloud: {
    /** Resolved from the credential the deployment mounts, never authored. */
    readonly federation: FederationConfig | null;
  };
};

/** The document both halves of a pointer are resolved against. */
type PointedAt = Pick<AuthoredManifest, 'installation' | 'vessels'>;

/**
 * The vessel one of the installation's two pointers names.
 *
 * Total, because the document-level refinement above already refused a pointer
 * that resolves to nothing — so a validated manifest cannot reach here without
 * an answer, and the throw is the assertion of that rather than a case a caller
 * has to handle.
 */
function pointedVessel(manifest: PointedAt, name: string): VesselSeed {
  const vessel = manifest.vessels.find((declared) => declared.name === name);
  if (vessel === undefined) {
    throw new Error(`no vessel named ${name} is declared`);
  }
  return vessel;
}

/** The vessel holding this installation's shared services. */
export function homeVesselOf(manifest: PointedAt): VesselSeed {
  return pointedVessel(manifest, manifest.installation.homeVessel);
}

/** The vessel this control plane runs on (§19). */
export function controlPlaneVesselOf(manifest: PointedAt): VesselSeed {
  return pointedVessel(manifest, manifest.installation.controlPlaneVessel);
}

/**
 * The source bucket, the artifacts project and the store container, read off
 * the one vessel that holds them.
 *
 * Total for the same reason {@link pointedVessel} is: the refinement requires
 * the home vessel to declare this block and forbids every other vessel from
 * carrying one, so there is exactly one answer and it is present.
 */
export function sharedServicesOf(manifest: PointedAt): SharedServices {
  const home = homeVesselOf(manifest);
  if (home.shared === undefined) {
    throw new Error(`${home.name} declares no shared services`);
  }
  return home.shared;
}

/**
 * The project the home vessel is, or `null` where the declaration seeds its
 * identity without saying where it is.
 *
 * `null` rather than a throw because that half-ready state is one §13 intends to
 * be visible: `location` is optional on a vessel seed for the same reason the
 * column is nullable, and a bucket check against `undefined` is worse than a
 * stated absence.
 */
export function homeVesselProjectOf(manifest: PointedAt): string | null {
  const location = homeVesselOf(manifest).location;
  return location !== undefined && 'project' in location
    ? location.project
    : null;
}

/**
 * Whether this vessel is one the installation itself is built on.
 *
 * The predicate every guard and every read-only screen asks. Neither pointer is
 * a foreign key, so this is what stands in for one.
 */
export function isDeclaredInstallationVessel(
  manifest: Pick<AuthoredManifest, 'installation'>,
  vessel: string,
): boolean {
  return (
    vessel === manifest.installation.homeVessel ||
    vessel === manifest.installation.controlPlaneVessel
  );
}

/**
 * Where this boundary is declared in the infrastructure repository, or `null`
 * when nothing declares it.
 *
 * By name against the document rather than off the row, because it is a fact
 * about where the *declaration* lives: a boundary connected through the UI has
 * a row and no root, which is the state the null arm exists for.
 */
export function terraformRootOf(
  manifest: Pick<AuthoredManifest, 'vessels'>,
  vessel: string,
): string | null {
  const declared = manifest.vessels.find((seed) => seed.name === vessel);
  return declared?.terraformRoot ?? null;
}

/**
 * Every path in a document a mounted declaration governs, as
 * `web/forms/document.ts` addresses one — the two pointers, and whichever
 * entries of `vessels` they name. `[]` when nothing is mounted, which is when
 * nothing is governed.
 *
 * **By name resolved against the document, never by a position carried from
 * anywhere else.** `vessels` is an array an editing surface adds to and removes
 * from, so a position computed before an edit addresses a different entry after
 * it.
 *
 * Both arguments are `unknown` because both callers hold one: the declaration
 * arrives over the wire and the document is mid-edit, and a predicate that only
 * answered for a document that already validates would stop locking exactly
 * while a mistake was being typed.
 */
export function governedManifestPaths(
  declaration: unknown,
  document: unknown,
): readonly (readonly (string | number)[])[] {
  const pointers = (declaration as { installation?: Record<string, unknown> })
    ?.installation;
  const governed = new Set(
    (['controlPlaneVessel', 'homeVessel'] as const)
      .map((key) => pointers?.[key])
      .filter((name): name is string => typeof name === 'string'),
  );
  if (governed.size === 0) return [];

  const declared = (document as { vessels?: unknown })?.vessels;
  const entries = Array.isArray(declared) ? declared : [];
  return [
    ['installation', 'controlPlaneVessel'],
    ['installation', 'homeVessel'],
    ...entries.flatMap((vessel, index) => {
      const name = (vessel as { name?: unknown })?.name;
      return typeof name === 'string' && governed.has(name)
        ? [['vessels', index] as readonly (string | number)[]]
        : [];
    }),
  ];
}

/**
 * Project a resolved manifest back down to the document an operator may write.
 *
 * The inverse of the join `resolveManifest` performs, and it exists because an
 * editing surface reads before it writes. `getInstallationManifest` answers
 * what a reader holds and `configureInstallation` accepts only what may be
 * authored; if those are different documents the round trip refuses itself on
 * a key the operator can neither see nor correct — the schema is `.strict()`,
 * so a derived key coming back in is an `Unrecognized key` on a form the
 * operator never touched.
 *
 * Lives here rather than beside the join because it is a fact about the two
 * types, and because the read command must stay free of server-only imports.
 */
export function toAuthoredManifest(
  manifest: InstallationManifest,
): AuthoredManifest {
  const { cloud: _derived, ...authored } = manifest;
  return authored;
}
