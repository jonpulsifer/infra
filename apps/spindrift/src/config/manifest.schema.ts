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
 */
import { z } from 'zod';

/** A non-empty string with no surrounding whitespace. */
const nonEmptyString = z.string().trim().min(1);

/** A DNS zone apex, e.g. `apps.example.test`. */
const zone = nonEmptyString.regex(
  /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/,
  'must be a lowercase dotted DNS name',
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
 * minted per request — the App key for hosted CI, a federated token for the
 * cloud builder, the projected service account token in-cluster.
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

/**
 * A Target as the manifest seeds it. The connect act (Task 13) owns the rest of
 * the model; this is only what must exist before the first boot can place
 * anything.
 */
export const targetSeedSchema = z
  .object({
    /** Stable identifier, unique within the installation. */
    name: nonEmptyString,
    /** Which delivery adapter drives it. */
    adapter: targetAdapterSchema,
  })
  .strict();

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
         * It is not derived from `dns.apexZone`: the control plane is a
         * platform workload (§19) and never one of its own Apps, so it does not
         * live in the zone Apps are named in.
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
         * Dedicated apex Spindrift mints canonical names under, disjoint from
         * any hand-managed flat space (§9).
         */
        apexZone: zone,
        /**
         * Zone the flat single-label vanity names are layered on (§9). May be
         * the same zone as the apex; it is named separately because the two are
         * allowed to diverge.
         */
        vanityZone: zone,
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
         * How this installation reaches a cloud Target, with nothing stored
         * (§13's one auth mode).
         *
         * The shape is an `external_account` credential document's, field for
         * field, because an operator configuring this has one already and
         * copying it should be the whole of the work.
         *
         * Nullable, stated the way `auth.gateway` and `github.buildWorkflow`
         * are: an installation with no cloud Targets has no honest value to put
         * here, and a placeholder would be a configuration that looks complete
         * and fails on the first deploy. Null means cloud Targets cannot be
         * reached, and nothing else changes.
         */
        federation: z
          .object({
            /** The workload-identity pool provider this cluster is trusted by. */
            audience: nonEmptyString,
            /** Where a projected token is exchanged for a federated one. */
            tokenUrl: z.url(),
            /**
             * Where the projected token is read from.
             *
             * No default, and deliberately so: the convenient path — the
             * default service account token — is minted for this cluster's own
             * API server and a cloud API refuses it. Requiring the operator to
             * name the volume they projected keeps the wrong token from being
             * the easy one.
             */
            tokenPath: nonEmptyString.regex(
              /^\//,
              'must be an absolute path inside the pod',
            ),
            /**
             * The service account to impersonate, as a `generateAccessToken`
             * url, or null to use the federated identity's own grants.
             */
            impersonationUrl: z.url().nullable(),
          })
          .strict()
          .nullable(),
      })
      .strict(),

    charts: z
      .object({
        /**
         * Reference to the App chart (§7) — the chart every deployed Component
         * renders through.
         */
        app: nonEmptyString,
        /**
         * Reference to the installer chart (§19) — the chart this installation
         * itself was installed from.
         */
        installer: nonEmptyString,
      })
      .strict(),

    supplyChain: z
      .object({
        /**
         * Registry every artifact is pushed to and pulled from (§16). Named
         * here rather than derived from the artifacts project because a
         * mirror in front of it is a legitimate installation choice, and
         * `offlineDeploy` (§3, §33) is derived from which host this names.
         */
        registry: nonEmptyString,
        /**
         * Where signature verification fetches its material (§16) — the third
         * of the deploy path's references `offlineDeploy` is checked over.
         */
        verifier: nonEmptyString,
      })
      .strict(),

    github: z
      .object({
        /** Numeric id of the GitHub App used for repository integration (§15). */
        appId: nonEmptyString.regex(
          /^[0-9]+$/,
          'must be a numeric GitHub App id',
        ),
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
     * Targets that exist before anyone connects one, in rank order — rank is one
     * global ordered list (§13), so the order of this array is the order
     * placement considers them in.
     */
    targets: z
      .array(targetSeedSchema)
      .min(1)
      .refine(
        (targets) =>
          new Set(targets.map((t) => t.name)).size === targets.length,
        'target names must be unique',
      ),
  })
  .strict();

export type TargetAdapter = z.infer<typeof targetAdapterSchema>;
export type StoreAdapter = z.infer<typeof storeAdapterSchema>;
export type BuildRouteAdapter = z.infer<typeof buildRouteAdapterSchema>;
export type BuildRouteConfig = z.infer<typeof buildRouteSchema>;
export type TargetSeed = z.infer<typeof targetSeedSchema>;
export type GatewayAuthConfig = z.infer<typeof gatewayAuthSchema>;
export type InstallationManifest = z.infer<typeof installationManifestSchema>;
