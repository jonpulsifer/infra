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
      })
      .strict(),

    secretStore: z
      .object({
        /** Which store adapter this installation delivers config through. */
        adapter: storeAdapterSchema,
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
export type TargetSeed = z.infer<typeof targetSeedSchema>;
export type InstallationManifest = z.infer<typeof installationManifestSchema>;
