/**
 * `listBuildRoutes` — every configured build route, for Settings→Connections.
 *
 * `buildRouteFor` (`builds/route.ts`) answers "which route for this Target",
 * scoped to a placement. This answers a smaller, installation-wide question a
 * picker never asks: what routes exist at all, and — for the one route this
 * process cannot reach out to — is anything on the other end. `bosun.ts`'s
 * adapter only ever writes an outbox row and polls it back; nothing before
 * this command ever read `build_requests` for depth or read
 * `storage/bosun-poll.ts` for a pulse, so an operator had no way to tell a
 * `pool` route that is declared-but-unserved from one that is merely quiet.
 */
import { z } from 'zod';
import type { BuildLevel } from '../../adapters/build/contract.ts';
import { buildRouteProfiles } from '../../adapters/registry.ts';
import { elapsedSince } from '../../domain/elapsed.ts';
import { lastClaimPollAt } from '../../storage/bosun-poll.ts';
import { buildOutbox } from '../../storage/build-outbox.ts';
import { type Command, ok } from '../types.ts';

export const listBuildRoutesInput = z.object({}).strict();
export type ListBuildRoutesInput = z.infer<typeof listBuildRoutesInput>;

/** What the outbox says about a bosun route's pool, in the words a screen uses. */
export interface BosunPoolHealthView {
  /** `null` where this process has answered no authenticated claim poll yet. */
  readonly lastClaimPollAgo: string | null;
  readonly pending: number;
  readonly claimed: number;
  /** `null` where nothing is `PENDING`. */
  readonly oldestPendingAgo: string | null;
}

/** One configured route, as the manifest declares it. */
export interface BuildRouteView {
  readonly name: string;
  readonly adapter: string;
  readonly level: BuildLevel;
  /** Present only for a `bosun`-adapter route — every other route is dialed, not polled. */
  readonly bosun: BosunPoolHealthView | null;
}

export interface ListBuildRoutesResult {
  readonly routes: readonly BuildRouteView[];
}

export const listBuildRoutes: Command<
  ListBuildRoutesInput,
  ListBuildRoutesResult
> = async (_input, context) => {
  const levelByName = new Map(
    buildRouteProfiles(context.manifest).map((route) => [
      route.name,
      route.level,
    ]),
  );

  const bosunRoutes = context.manifest.build.routes.filter(
    (route) => route.adapter === 'bosun',
  );
  const now = context.clock.now();
  const statsByClass =
    bosunRoutes.length === 0
      ? {}
      : await buildOutbox(context.db, context.clock.now).stats(
          bosunRoutes.map((route) => route.class),
        );
  const polledAt = lastClaimPollAt();
  const lastClaimPollAgo =
    polledAt === null ? null : elapsedSince(polledAt, now);

  return ok({
    routes: context.manifest.build.routes.map((route) => {
      const level = levelByName.get(route.name) ?? 1;
      if (route.adapter !== 'bosun') {
        return { name: route.name, adapter: route.adapter, level, bosun: null };
      }
      const classStats = statsByClass[route.class] ?? {
        pending: 0,
        claimed: 0,
        oldestPendingAt: null,
      };
      return {
        name: route.name,
        adapter: route.adapter,
        level,
        bosun: {
          lastClaimPollAgo,
          pending: classStats.pending,
          claimed: classStats.claimed,
          oldestPendingAgo:
            classStats.oldestPendingAt === null
              ? null
              : elapsedSince(classStats.oldestPendingAt, now),
        },
      };
    }),
  });
};
