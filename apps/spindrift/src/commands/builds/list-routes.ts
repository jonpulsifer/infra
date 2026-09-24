/**
 * Lists every configured build route for Settings. A `bosun` route adds its
 * outbox depth and last claim poll, to tell an unserved pool from a quiet one.
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

export interface BosunPoolHealthView {
  /** `null` until this process answers an authenticated claim poll. */
  readonly lastClaimPollAgo: string | null;
  readonly pending: number;
  readonly claimed: number;
  /** `null` when nothing is `PENDING`. */
  readonly oldestPendingAgo: string | null;
}

export interface BuildRouteView {
  readonly name: string;
  readonly adapter: string;
  readonly level: BuildLevel;
  /** Null except on a `bosun` route: every other route is dialed, not polled. */
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
