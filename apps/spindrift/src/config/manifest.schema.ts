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

/** A Target identifier accepted by both the manifest and the connect act. */
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
export const targetAdapterSchema = z.enum(['kubernetes', 'cloudrun', 'static']);

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
export const buildRouteAdapterSchema = z.enum([
  'github-actions',
  'cloud-build',
  'in-cluster',
]);

/**
 * One configured build route.
 *
 * A discriminated union rather than a bag of optional keys, for the same reason
 * `TargetConnection` is one: a `github-actions` route with a cluster namespace
 * is not a state this model has a name for.
 *
 * **No credential appears in any variant** (§13). Each route's access path is
 * resolved per request — the encrypted OAuth credential for hosted CI, a
 * federated token for the cloud builder, the projected service account token
 * in-cluster.
 */
export const buildRouteSchema = z.discriminatedUnion('adapter', [
  z
    .object({
      /** What this route is called, as `Target.buildRoutes` names it. */
      name: nonEmptyString,
      adapter: z.literal('github-actions'),
    })
    .strict(),
  z
    .object({
      name: nonEmptyString,
      adapter: z.literal('cloud-build'),
      /**
       * The build service's API root, without a trailing slash. A value for
       * the same reason `github.apiBaseUrl` is one: a regional or
       * perimeter-fronted endpoint is a legitimate installation choice.
       */
      endpoint: z.url(),
      /** Where the build's own logs are read from — §4's "logs are read". */
      logsEndpoint: z.url(),
      /** The project builds run in — §14's shared artifacts project. */
      project: nonEmptyString,
      /** The location builds are submitted to. */
      region: nonEmptyString,
      /**
       * The BuildKit image the build step runs, pinned by the installation.
       *
       * Present here as well as on the in-cluster route because §4 makes the
       * engine one thing that runs in several places — the route decides where,
       * never what.
       */
      image: nonEmptyString,
    })
    .strict(),
  z
    .object({
      name: nonEmptyString,
      adapter: z.literal('in-cluster'),
      /** The API server the build Job is created against. */
      endpoint: z.url(),
      /** The namespace it is created in. Never created by Spindrift. */
      namespace: nonEmptyString,
      /** The BuildKit image the Job runs, pinned by the installation. */
      image: nonEmptyString,
      /**
       * The service account the Job runs as — how it authorizes a push
       * without this process holding a registry credential.
       */
      serviceAccount: nonEmptyString,
    })
    .strict(),
]);

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
 * A Target declared by installation desired state.
 *
 * Connection facts are optional so an operator may still seed an identity and
 * connect it through the product. When supplied, they are ordinary,
 * credential-free platform configuration and make the connection reproducible
 * from Git.
 */
export const targetSeedSchema = z.discriminatedUnion('adapter', [
  z
    .object({
      /** Stable identifier, unique within the installation. */
      name: targetNameSchema,
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
          apiServer: z.url(),
          namespace: nonEmptyString,
          delivery: kubernetesDeliverySchema,
          servedHosts: z.array(nonEmptyString).optional(),
          reachableRegistries: z.array(nonEmptyString).optional(),
          logHistorySeconds: z.number().int().nonnegative().optional(),
          chartContract: nonEmptyString.optional(),
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
      name: targetNameSchema,
      adapter: z.literal('cloudrun'),
      connection: z
        .object({
          project: nonEmptyString,
          region: nonEmptyString,
          endpoint: z.url(),
          policyEndpoint: z.url().optional(),
          /** The identity a revision runs as. See `CloudRunConnection`. */
          serviceAccount: nonEmptyString.optional(),
          servedHosts: z.array(nonEmptyString).optional(),
          reachableRegistries: z.array(nonEmptyString).optional(),
          logHistorySeconds: z.number().int().nonnegative().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      name: targetNameSchema,
      adapter: z.literal('static'),
      connection: z
        .object({
          project: nonEmptyString,
          endpoint: z.url(),
          servedHosts: z.array(nonEmptyString).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);

export const installationManifestSchema = z
  .object({
    /**
     * Opaque label for this installation. Appears in the UI and in logs; it
     * carries no behaviour.
     */
    installation: nonEmptyString,

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
         * One zone per reach, each dedicated to generated names and disjoint
         * from any hand-managed flat space (§9).
         *
         * They are named separately because they are allowed to diverge, and the
         * choice is the installation's rather than the product's: a homelab
         * points both at one zone, so flipping a Component's reach is a record
         * re-point and its hostname is stable; a work installation points them
         * at different zones — separate trust boundaries, split-horizon
         * resolvers — and accepts that changing reach is a rename.
         */
        zones: z
          .object({
            private: zone,
            public: zone,
          })
          .strict(),
      })
      .strict(),

    sources: z
      .object({
        /**
         * First-party GCS buckets for staging archive sources and artifacts (§4, §13).
         */
        buckets: z.array(nonEmptyString).min(1),
        /**
         * Default GCS bucket for staging archive sources and artifacts.
         */
        defaultBucket: nonEmptyString.optional(),
      })
      .strict(),

    cloud: z
      .object({
        /**
         * Project holding immutable build artifacts and signing material. Shared
         * across every vessel (§14).
         */
        artifactsProject: nonEmptyString,
        /**
         * Spindrift's own project, and the default shared vessel for Apps that
         * do not choose one (§14).
         */
        homeVesselProject: nonEmptyString,
        /**
         * **No `federation` key, and that is the point.**
         *
         * §13's one auth mode — "native OIDC federation, nothing stored" — is
         * an `external_account` credential document, and the installer chart
         * already writes one from the workload-identity audience and mount path
         * a release names. Asking for the same four facts here made a second
         * copy, by hand, in a document the chart does not render; the two could
         * disagree, they did, and the failure arrived as a `signBlob` refusal
         * that read as a code defect.
         *
         * It is now resolved from the mounted credential —
         * `federation-credential.ts` — and appears on {@link
         * InstallationManifest} without ever being authored. Nullable exactly
         * as before, and for the same reason: an installation with no cloud
         * Targets mounts no credential and has no honest value here.
         */
      })
      .strict(),

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
         * (§15).
         *
         * **Pinned to a commit, and the schema is what enforces it.** §15 gives
         * the connected repository the Actions minutes and the billing, which
         * means the workflow runs with that repository's own permissions —
         * so a mutable ref here would let whoever can move it run arbitrary
         * steps in every connected repository at once. A branch or tag is
         * refused rather than warned about.
         *
         * Nullable, stated the way `auth.gateway` is: an installation that has
         * not published a reusable workflow yet has no honest value to put here,
         * and a placeholder commit would be a configuration that looks complete
         * and fails at the first build. Null means repositories cannot be
         * connected — `connectRepository` says so — and nothing else changes.
         */
        buildWorkflow: nonEmptyString
          .regex(
            /^[^/@\s]+\/[^/@\s]+\/\.github\/workflows\/[^@\s]+@[0-9a-f]{40}$/,
            'must be owner/repo/.github/workflows/<file>@<40-character commit sha>',
          )
          .nullable(),
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
         * What holds the items inside that store: the vessel project for Secret
         * Manager, the vault for 1Password.
         *
         * One key rather than one per adapter, because the two are the same
         * thing under different names, and a per-adapter block would let an
         * installation configure a store it does not use.
         */
        container: nonEmptyString,
      })
      .strict(),

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
          new Set(targets.map((t) => t.name)).size === targets.length,
        'target names must be unique',
      )
      .superRefine((targets, context) => {
        const seeds = new Map(targets.map((target) => [target.name, target]));
        targets.forEach((target, index) => {
          if (target.adapter === 'kubernetes') return;

          const suffix = `-${target.adapter}`;
          const base = target.name.endsWith(suffix)
            ? target.name.slice(0, -suffix.length)
            : '';
          const counterpart =
            target.adapter === 'cloudrun' ? 'static' : 'cloudrun';
          const counterpartName = `${base}-${counterpart}`;
          if (
            base.length === 0 ||
            seeds.get(counterpartName)?.adapter !== counterpart
          ) {
            context.addIssue({
              code: 'custom',
              path: [index, 'name'],
              message:
                'cloud Targets must be a matched <name>-cloudrun and ' +
                '<name>-static pair',
            });
          }
        });
      }),
  })
  .strict();

export type TargetAdapter = z.infer<typeof targetAdapterSchema>;
export type StoreAdapter = z.infer<typeof storeAdapterSchema>;
export type BuildRouteAdapter = z.infer<typeof buildRouteAdapterSchema>;
export type BuildRouteConfig = z.infer<typeof buildRouteSchema>;
export type TargetSeed = z.infer<typeof targetSeedSchema>;
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
export type InstallationManifest = Omit<AuthoredManifest, 'cloud'> & {
  readonly cloud: AuthoredManifest['cloud'] & {
    /** Resolved from the credential the deployment mounts, never authored. */
    readonly federation: FederationConfig | null;
  };
};

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
  const { federation: _derived, ...cloud } = manifest.cloud;
  return { ...manifest, cloud };
}
