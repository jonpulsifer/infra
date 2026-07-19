import { type EffectiveBootOutcome, resolveBootPolicy } from './boot-decision';
import type { BootCatalog } from './catalog';
import type { BootOutcome, Observation } from './observations';
import { getSpore } from './spore';

export interface HostReadModel {
  readonly macAddress: string;
  readonly hostname: string | null;
  readonly profileId: string | null;
  readonly effectiveOutcome: EffectiveBootOutcome;
  readonly configured: boolean;
  readonly firstSeen: string | null;
  readonly lastSeen: string | null;
  readonly bootCount: number;
  readonly lastOutcome: BootOutcome | null;
  readonly lastProfile: string | null;
}

export interface ProfileReadModel {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly content: string;
  readonly isDefault: boolean;
  readonly hostCount: number;
}

export interface ScriptReadModel {
  readonly path: string;
  readonly description?: string;
  readonly content: string;
}

export interface SporeReadModel {
  readonly catalog: Readonly<
    Pick<BootCatalog, 'serverOrigin' | 'allowUnknownHosts' | 'defaultProfile'>
  >;
  readonly hosts: readonly HostReadModel[];
  readonly profiles: readonly ProfileReadModel[];
  readonly scripts: readonly ScriptReadModel[];
}

const emptyObservation = {
  firstSeen: null,
  lastSeen: null,
  bootCount: 0,
  lastOutcome: null,
  lastProfile: null,
} as const;

export function buildReadModel(
  catalog: BootCatalog,
  observations: readonly Observation[],
): SporeReadModel {
  const observationByMac = new Map(
    observations.map((observation) => [observation.macAddress, observation]),
  );

  const configuredHosts = Object.entries(catalog.hosts).map(
    ([macAddress, host]): HostReadModel => {
      const observation = observationByMac.get(macAddress);
      const policy = resolveBootPolicy(catalog, macAddress);
      observationByMac.delete(macAddress);
      return Object.freeze({
        ...(observation ?? emptyObservation),
        macAddress,
        hostname: host.hostname,
        profileId: policy.profileId,
        effectiveOutcome: policy.outcome,
        configured: true,
      });
    },
  );

  const observedOnlyHosts = [...observationByMac.values()].map(
    (observation): HostReadModel => {
      const policy = resolveBootPolicy(catalog, observation.macAddress);
      return Object.freeze({
        ...observation,
        hostname: null,
        profileId: policy.profileId,
        effectiveOutcome: policy.outcome,
        configured: false,
      });
    },
  );

  const hosts = [...configuredHosts, ...observedOnlyHosts].sort(
    (left, right) => {
      if (left.configured !== right.configured) return left.configured ? -1 : 1;
      return (left.hostname ?? left.macAddress).localeCompare(
        right.hostname ?? right.macAddress,
      );
    },
  );

  const profiles = Object.entries(catalog.profiles)
    .map(
      ([id, profile]): ProfileReadModel =>
        Object.freeze({
          id,
          ...profile,
          isDefault: id === catalog.defaultProfile,
          hostCount: hosts.filter(
            (host) => host.configured && host.profileId === id,
          ).length,
        }),
    )
    .sort((left, right) => left.name.localeCompare(right.name));

  const scripts = Object.entries(catalog.scripts)
    .map(
      ([path, script]): ScriptReadModel => Object.freeze({ path, ...script }),
    )
    .sort((left, right) => left.path.localeCompare(right.path));

  return Object.freeze({
    catalog: Object.freeze({
      serverOrigin: catalog.serverOrigin,
      allowUnknownHosts: catalog.allowUnknownHosts,
      defaultProfile: catalog.defaultProfile,
    }),
    hosts: Object.freeze(hosts),
    profiles: Object.freeze(profiles),
    scripts: Object.freeze(scripts),
  });
}

export async function getReadModel(): Promise<SporeReadModel> {
  const { catalog, observations } = getSpore();
  return buildReadModel(catalog, observations.listObservations());
}
