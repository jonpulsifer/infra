import {
  type BootCatalog,
  type BootHost,
  type BootProfile,
  isNativeBootArtifact,
  isSafeScriptPath,
} from './catalog';
import {
  buildTemplateContext,
  invalidMacScript,
  localBootScript,
  missingScript,
  normalizeMac,
  processTemplate,
  unregisteredHostScript,
} from './ipxe';
import type {
  BootAttempt,
  BootOutcome,
  ObservationRepository,
} from './observations';

export type BootDecisionOutcome = BootOutcome | 'invalid-mac';

export interface BootDecision {
  readonly status: number;
  readonly outcome: BootDecisionOutcome;
  readonly profileId: string | null;
  readonly content: string;
}

export interface ScriptDecision {
  readonly status: number;
  readonly outcome: 'script' | 'script-not-found' | 'invalid-mac';
  readonly content: string;
}

export interface NativeBootDecision {
  readonly status: 200 | 404;
  readonly outcome: 'native-boot' | 'native-boot-not-found';
  readonly internalPath: string | null;
}

export interface BootDecisionService {
  decideBoot(macAddress: string): BootDecision;
  renderScript(path: string, macAddress?: string | null): ScriptDecision;
  resolveNativeBoot(
    targetId: string,
    artifact: string,
    squashfsDigest?: string | null,
  ): NativeBootDecision;
}

export interface BootDecisionOptions {
  readonly catalog: BootCatalog;
  readonly observations: ObservationRepository;
  readonly onObservationError?: (error: unknown) => void;
}

export type EffectiveBootOutcome = Extract<
  BootOutcome,
  | 'profile'
  | 'default-profile'
  | 'unknown-allowed'
  | 'unknown-denied'
  | 'missing-profile'
>;

export type EffectiveBootPolicy =
  | Readonly<{
      host: BootHost | null;
      profile: null;
      profileId: null;
      outcome: 'unknown-denied' | 'missing-profile';
    }>
  | Readonly<{
      host: BootHost | null;
      profile: BootProfile;
      profileId: string;
      outcome: 'profile' | 'default-profile' | 'unknown-allowed';
    }>;

export function resolveBootPolicy(
  catalog: BootCatalog,
  macAddress: string,
): EffectiveBootPolicy {
  const host = catalog.hosts[macAddress] ?? null;
  if (!host && !catalog.allowUnknownHosts) {
    return {
      host,
      profile: null,
      profileId: null,
      outcome: 'unknown-denied',
    };
  }

  const profileId = host?.profile ?? catalog.defaultProfile;
  const profile = profileId ? (catalog.profiles[profileId] ?? null) : null;
  if (!profileId || !profile) {
    return {
      host,
      profile: null,
      profileId: null,
      outcome: 'missing-profile',
    };
  }

  return {
    host,
    profile,
    profileId,
    outcome: host
      ? host.profile
        ? 'profile'
        : 'default-profile'
      : 'unknown-allowed',
  };
}

export function createBootDecisionService({
  catalog,
  observations,
  onObservationError = (error) =>
    console.error('Unable to record Spore boot observation', error),
}: BootDecisionOptions): BootDecisionService {
  const record = (attempt: BootAttempt): void => {
    try {
      observations.recordBootAttempt(attempt);
    } catch (error) {
      onObservationError(error);
    }
  };

  const renderProfile = (
    macAddress: string,
    host: BootHost | null,
    profile: BootProfile,
  ): string =>
    processTemplate(
      profile.content,
      buildTemplateContext(macAddress, host, profile, catalog.serverOrigin),
    );

  return Object.freeze({
    decideBoot(rawMacAddress: string): BootDecision {
      let macAddress: string;
      try {
        macAddress = normalizeMac(rawMacAddress);
      } catch {
        return {
          status: 400,
          outcome: 'invalid-mac',
          profileId: null,
          content: invalidMacScript(rawMacAddress),
        };
      }

      const policy = resolveBootPolicy(catalog, macAddress);
      if (policy.profile === null) {
        // iPXE only executes a chained response body on a successful HTTP
        // status. Policy denial is represented by the explicit outcome and
        // safe script, not an HTTP error that would strand boot.
        const decision: BootDecision = {
          status: 200,
          outcome: policy.outcome,
          profileId: null,
          content:
            policy.outcome === 'unknown-denied'
              ? unregisteredHostScript(macAddress)
              : localBootScript(macAddress),
        };
        record({ macAddress, outcome: policy.outcome, profileId: null });
        return decision;
      }

      const decision: BootDecision = {
        status: 200,
        outcome: policy.outcome,
        profileId: policy.profileId,
        content: renderProfile(macAddress, policy.host, policy.profile),
      };
      record({
        macAddress,
        outcome: policy.outcome,
        profileId: policy.profileId,
      });
      return decision;
    },

    renderScript(path: string, rawMacAddress?: string | null): ScriptDecision {
      if (!isSafeScriptPath(path) || !Object.hasOwn(catalog.scripts, path)) {
        return {
          status: 404,
          outcome: 'script-not-found',
          content: missingScript(path),
        };
      }

      const rawMac = rawMacAddress || '00:00:00:00:00:00';
      let macAddress: string;
      try {
        macAddress = normalizeMac(rawMac);
      } catch {
        return {
          status: 400,
          outcome: 'invalid-mac',
          content: invalidMacScript(rawMac),
        };
      }

      const script = catalog.scripts[path];
      const host = catalog.hosts[macAddress] ?? null;
      const profileId = host?.profile ?? catalog.defaultProfile;
      const profile = profileId ? (catalog.profiles[profileId] ?? null) : null;
      return {
        status: 200,
        outcome: 'script',
        content: processTemplate(
          script.content,
          buildTemplateContext(macAddress, host, profile, catalog.serverOrigin),
        ),
      };
    },

    resolveNativeBoot(
      targetId: string,
      artifact: string,
      squashfsDigest?: string | null,
    ): NativeBootDecision {
      const target = Object.hasOwn(catalog.nativeBootTargets, targetId)
        ? catalog.nativeBootTargets[targetId]
        : undefined;
      if (!target || !isNativeBootArtifact(artifact)) {
        return {
          status: 404,
          outcome: 'native-boot-not-found',
          internalPath: null,
        };
      }

      const internalPath =
        artifact === 'nix-store.squashfs'
          ? squashfsDigest?.match(/^[0-9a-f]{64}$/)
            ? `/_spore-native-boot/stores/${squashfsDigest}.squashfs`
            : null
          : `/_spore-native-boot/${targetId}/${artifact}`;
      if (internalPath === null) {
        return {
          status: 404,
          outcome: 'native-boot-not-found',
          internalPath: null,
        };
      }

      if (artifact === 'boot.img') {
        record({
          macAddress: target.macAddress,
          outcome: 'native-boot',
          profileId: targetId,
        });
      }
      return {
        status: 200,
        outcome: 'native-boot',
        internalPath,
      };
    },
  });
}
