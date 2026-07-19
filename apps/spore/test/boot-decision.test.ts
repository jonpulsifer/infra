import { describe, expect, test } from 'bun:test';
import {
  type BootDecisionService,
  createBootDecisionService,
} from '../lib/boot-decision';
import { type BootCatalogInput, parseBootCatalog } from '../lib/catalog';
import type {
  BootAttempt,
  Observation,
  ObservationRepository,
} from '../lib/observations';

function catalogInput(): BootCatalogInput {
  return {
    serverOrigin: 'http://10.2.0.11/spore',
    allowUnknownHosts: false,
    defaultProfile: 'local',
    profiles: {
      local: {
        name: 'Local',
        content:
          '#!ipxe\necho {{mac}} {{hostname}} {{profile_name}} {{server_ip}} {{base_url}}\n',
      },
      k8s: {
        name: 'Kubernetes',
        content:
          '#!ipxe\nchain {{base_url}}/api/scripts/k8s/netboot.ipxe?mac={{mac}}\n',
      },
    },
    scripts: {
      'k8s/netboot.ipxe': {
        content:
          '#!ipxe\necho {{mac_hyphen}} {{hostname}}\nchain http://{{server_ip}}/netboot/netboot.ipxe\n',
      },
    },
    hosts: {
      'aa:bb:cc:dd:ee:01': { hostname: 'nuc', profile: 'k8s' },
      'aa:bb:cc:dd:ee:02': { hostname: 'optiplex' },
    },
    nativeBootTargets: {
      rackpi5: {
        hostname: 'rackpi5',
        macAddress: '2c:cf:67:dc:7e:9b',
        protocol: 'raspberry-pi-http',
      },
    },
  };
}

function fakeObservations(options?: { throwOnRecord?: boolean }) {
  const attempts: BootAttempt[] = [];
  const repository: ObservationRepository = {
    recordBootAttempt(attempt) {
      if (options?.throwOnRecord) throw new Error('disk is read-only');
      attempts.push(attempt);
    },
    getObservation() {
      return null;
    },
    listObservations(): readonly Observation[] {
      return [];
    },
  };
  return { attempts, repository };
}

function service(
  input = catalogInput(),
  options?: { throwOnRecord?: boolean },
): { service: BootDecisionService; attempts: BootAttempt[] } {
  const observations = fakeObservations(options);
  return {
    service: createBootDecisionService({
      catalog: parseBootCatalog(input),
      observations: observations.repository,
      onObservationError: () => {},
    }),
    attempts: observations.attempts,
  };
}

describe('boot decisions', () => {
  test('normalizes a known host and renders its assigned profile', () => {
    const { service: boot, attempts } = service();
    const decision = boot.decideBoot('AA-BB-CC-DD-EE-01');

    expect(decision).toEqual({
      status: 200,
      outcome: 'profile',
      profileId: 'k8s',
      content:
        '#!ipxe\nchain http://10.2.0.11/spore/api/scripts/k8s/netboot.ipxe?mac=aa:bb:cc:dd:ee:01\n',
    });
    expect(attempts).toEqual([
      {
        macAddress: 'aa:bb:cc:dd:ee:01',
        outcome: 'profile',
        profileId: 'k8s',
      },
    ]);
  });

  test('uses the selected default for a configured host without assignment', () => {
    const { service: boot, attempts } = service();
    const decision = boot.decideBoot('aa:bb:cc:dd:ee:02');

    expect(decision.status).toBe(200);
    expect(decision.outcome).toBe('default-profile');
    expect(decision.profileId).toBe('local');
    expect(decision.content).toContain(
      'aa:bb:cc:dd:ee:02 optiplex Local 10.2.0.11 http://10.2.0.11/spore',
    );
    expect(attempts[0]?.outcome).toBe('default-profile');
  });

  test('returns local boot when no assigned or default profile exists', () => {
    const input = catalogInput();
    input.defaultProfile = null;
    input.hosts['aa:bb:cc:dd:ee:02'].profile = undefined;
    const { service: boot, attempts } = service(input);

    const decision = boot.decideBoot('aa:bb:cc:dd:ee:02');
    expect(decision.status).toBe(200);
    expect(decision.outcome).toBe('missing-profile');
    expect(decision.profileId).toBeNull();
    expect(decision.content).toContain('Booting to local disk');
    expect(attempts[0]?.outcome).toBe('missing-profile');
  });

  test('allows or denies unknown hosts according to catalog policy', () => {
    const allowedInput = catalogInput();
    allowedInput.allowUnknownHosts = true;
    const allowed = service(allowedInput);
    const allowedDecision = allowed.service.decideBoot('aa:bb:cc:dd:ee:99');
    expect(allowedDecision.status).toBe(200);
    expect(allowedDecision.outcome).toBe('unknown-allowed');
    expect(allowedDecision.profileId).toBe('local');
    expect(allowed.attempts[0]?.outcome).toBe('unknown-allowed');

    const denied = service();
    const deniedDecision = denied.service.decideBoot('aa:bb:cc:dd:ee:99');
    expect(deniedDecision.status).toBe(200);
    expect(deniedDecision.outcome).toBe('unknown-denied');
    expect(deniedDecision.content).toContain('Unknown host');
    expect(denied.attempts[0]?.outcome).toBe('unknown-denied');
  });

  test('returns a 400 iPXE response for malformed MAC without observing it', () => {
    const { service: boot, attempts } = service();
    expect(boot.decideBoot('not-a-mac')).toEqual({
      status: 400,
      outcome: 'invalid-mac',
      profileId: null,
      content: '#!ipxe\necho Invalid MAC address: not-a-mac\nexit\n',
    });
    expect(attempts).toEqual([]);
  });

  test('observation failure never blocks a boot decision', () => {
    const { service: boot } = service(catalogInput(), { throwOnRecord: true });
    expect(boot.decideBoot('aa:bb:cc:dd:ee:01').outcome).toBe('profile');
  });
});

describe('chainable scripts', () => {
  test('renders a found script with optional MAC context', () => {
    const { service: boot } = service();

    expect(boot.renderScript('k8s/netboot.ipxe', 'AA-BB-CC-DD-EE-01')).toEqual({
      status: 200,
      outcome: 'script',
      content:
        '#!ipxe\necho aa-bb-cc-dd-ee-01 nuc\nchain http://10.2.0.11/netboot/netboot.ipxe\n',
    });
    expect(boot.renderScript('k8s/netboot.ipxe').content).toContain(
      '00-00-00-00-00-00 unknown',
    );
  });

  test('returns explicit not-found and invalid-MAC decisions', () => {
    const { service: boot } = service();
    expect(boot.renderScript('missing.ipxe')).toEqual({
      status: 404,
      outcome: 'script-not-found',
      content: '#!ipxe\necho Script not found: missing.ipxe\nsleep 3\nexit\n',
    });
    expect(boot.renderScript('k8s/netboot.ipxe', 'broken').status).toBe(400);
    expect(boot.renderScript('../secret.ipxe').status).toBe(404);
    expect(boot.renderScript('k8s/net boot.ipxe').status).toBe(404);
    expect(boot.renderScript('constructor').status).toBe(404);
  });
});

describe('native boot assets', () => {
  test('resolves only declared target artifacts and observes the target MAC', () => {
    const { service: boot, attempts } = service();

    expect(boot.resolveNativeBoot('rackpi5', 'boot.img')).toEqual({
      status: 200,
      outcome: 'native-boot',
      internalPath: '/_spore-native-boot/rackpi5/boot.img',
    });
    expect(attempts).toEqual([
      {
        macAddress: '2c:cf:67:dc:7e:9b',
        outcome: 'native-boot',
        profileId: 'rackpi5',
      },
    ]);

    expect(boot.resolveNativeBoot('rackpi5', '../boot.img').status).toBe(404);
    expect(boot.resolveNativeBoot('missing', 'boot.sig').status).toBe(404);
    const digest = 'a'.repeat(64);
    expect(
      boot.resolveNativeBoot('rackpi5', 'nix-store.squashfs', digest),
    ).toEqual({
      status: 200,
      outcome: 'native-boot',
      internalPath: `/_spore-native-boot/stores/${digest}.squashfs`,
    });
    expect(
      boot.resolveNativeBoot('rackpi5', 'nix-store.squashfs'),
    ).toMatchObject({ status: 404, internalPath: null });
    expect(
      boot.resolveNativeBoot('rackpi5', 'nix-store.squashfs', '../current'),
    ).toMatchObject({ status: 404, internalPath: null });
    expect(attempts).toHaveLength(1);
  });
});
