/**
 * A website's build-time configuration (§4, §10).
 *
 * §10 makes exactly one exception to "one mechanism, no classification", and
 * states the reason rather than the rule: "a website's build-time config is
 * **derived mechanically from Component kind** and lives as ordinary rows,
 * because **whatever a website bakes becomes public either way**, so the
 * asymmetry does not exist there."
 *
 * Both halves of that sentence are load-bearing here.
 *
 * **Derived, never chosen.** {@link isBuildTimeConfig} takes a kind and nothing
 * else. There is no flag on the input, no per-key setting, and no way for a
 * service's configuration to become a build argument — which is what keeps the
 * exception narrow enough to be safe. A developer cannot opt a credential into
 * it, because there is nothing to opt.
 *
 * **Ordinary rows, so no builder holds a store credential.** §4 says it
 * outright: build arguments are "ordinary rows, never fetched from a store".
 * That is the whole security argument for this exception — the alternative is a
 * builder that can read the vault, which is a far larger surface than a public
 * value in a public bundle.
 *
 * What a website therefore cannot do is reference a stored secret. That is not
 * an omission: a value baked into a static site is readable by anyone who loads
 * the site, so a store that pretended otherwise would be selling a guarantee it
 * cannot keep.
 */
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { configItems, PINNED_ENVIRONMENT } from '../../db/schema.ts';
import type { ComponentKind } from '../../domain/desired-state.ts';

/**
 * Whether this kind's configuration is baked at build time.
 *
 * A `website` has no runtime to hold an environment: what a static bundle knows
 * it learned while it was being built. Everything else has a process, and a
 * process reads its configuration when it starts — which is why the exception
 * stops here rather than becoming a per-key choice.
 */
export function isBuildTimeConfig(kind: ComponentKind): boolean {
  return kind === 'website';
}

/**
 * The build arguments for one (Component, Target), as a builder takes them.
 *
 * Only `plain` rows: a `secret_ref` row holds a pinned reference and no value,
 * so there is nothing here that could accidentally resolve one. The two kinds
 * never mix on one Component, because the kind decides which is written.
 *
 * Sorted by key so two reads of the same configuration produce the same
 * arguments in the same order — a build that differed only in argument order
 * would produce a different digest for the same inputs.
 */
export async function readBuildArgs(
  db: Database,
  componentId: string,
  targetId: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select({ key: configItems.key, value: configItems.plainValue })
    .from(configItems)
    .where(
      and(
        eq(configItems.componentId, componentId),
        eq(configItems.targetId, targetId),
        eq(configItems.environment, PINNED_ENVIRONMENT),
        eq(configItems.kind, 'plain'),
      ),
    );

  return Object.fromEntries(
    rows
      .filter((row) => row.value !== null)
      .map((row) => [row.key, row.value as string])
      .sort(([left], [right]) =>
        (left as string).localeCompare(right as string),
      ),
  );
}
