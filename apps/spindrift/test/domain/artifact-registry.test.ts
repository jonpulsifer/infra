// These rules refuse a bad namespace when it is declared; otherwise it fails
// with NAME_INVALID at push, after the build has run.
import { describe, expect, test } from 'bun:test';
import {
  isRegistryNamespace,
  registryApiBase,
  registryFlavour,
} from '../../src/domain/artifact-name.ts';

describe('a registry namespace', () => {
  test('is a host and at least one path segment', () => {
    expect(isRegistryNamespace('registry.example.test/artifacts')).toBe(true);
    expect(isRegistryNamespace('registry.example.test/team/artifacts')).toBe(
      true,
    );
  });

  test('is not a bare host, which is what §16 names and cannot be pushed to', () => {
    expect(isRegistryNamespace('registry.example.test')).toBe(false);
  });

  test('is not a repository path with the host left to be inferred', () => {
    // Legal under Docker Hub's implicit host, but the client picks the host.
    expect(isRegistryNamespace('alpine/git')).toBe(false);
  });

  test('takes a port, and localhost, and refuses a malformed authority', () => {
    expect(isRegistryNamespace('localhost:5000/artifacts')).toBe(true);
    expect(isRegistryNamespace('registry.example.test:5000/artifacts')).toBe(
      true,
    );
    expect(isRegistryNamespace('registry.example.test:port/artifacts')).toBe(
      false,
    );
    expect(isRegistryNamespace('a:1:2/artifacts')).toBe(false);
  });

  test('refuses a path segment no registry would accept', () => {
    expect(isRegistryNamespace('registry.example.test/Artifacts')).toBe(false);
    expect(isRegistryNamespace('registry.example.test/')).toBe(false);
    expect(isRegistryNamespace('registry.example.test/a//b')).toBe(false);
  });
});

describe('which registry product answers for a host', () => {
  test('names the three this listing knows', () => {
    expect(registryFlavour('europe-docker.pkg.dev')).toBe('artifactRegistry');
    expect(registryFlavour('gcr.io')).toBe('artifactRegistry');
    expect(registryFlavour('docker.io')).toBe('dockerHub');
    expect(registryFlavour('ghcr.io')).toBe('ghcr');
  });

  test('and calls anything else what it is', () => {
    expect(registryFlavour('registry.example.test')).toBe('other');
  });

  test('reads the host through a port', () => {
    expect(registryFlavour('ghcr.io:443')).toBe('ghcr');
  });
});

describe('the distribution API a namespace is probed at', () => {
  test('is the host itself, over https', () => {
    expect(registryApiBase('ghcr.io')).toBe('https://ghcr.io/v2/');
    expect(registryApiBase('registry.example.test:5000')).toBe(
      'https://registry.example.test:5000/v2/',
    );
  });

  // docker.io does not serve the distribution API, so probing it as written
  // reports a working namespace unreachable.
  test('is the registry, not the index, for every name Docker Hub answers to', () => {
    for (const host of ['docker.io', 'index.docker.io', 'registry-1.docker.io'])
      expect(registryApiBase(host)).toBe('https://registry-1.docker.io/v2/');
  });
});
