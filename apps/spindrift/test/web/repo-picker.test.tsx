// `listRepositories` answers with the connected rows and the GitHub grant. A
// fresh installation has only the grant, so the picker must show both.
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  RepoPicker,
  repositoryChoices,
} from '../../src/web/components/repo-picker.tsx';
import { REPOSITORY_GRANT, REPOSITORY_OPTIONS } from '../fixtures/scenarios.ts';

const choices = repositoryChoices(REPOSITORY_OPTIONS, REPOSITORY_GRANT);
const stateOf = (fullName: string) =>
  choices.find((choice) => choice.fullName === fullName)?.state;

describe('what the picker offers', () => {
  test('every repository on either list is offered exactly once', () => {
    const names = choices.map((choice) => choice.fullName);
    expect(new Set(names).size).toBe(names.length);
    for (const repo of [...REPOSITORY_OPTIONS, ...REPOSITORY_GRANT]) {
      expect(names).toContain(repo.fullName);
    }
  });

  test('a repository the grant offers and nothing connected is still offered', () => {
    expect(
      repositoryChoices([], REPOSITORY_GRANT).map((c) => c.fullName),
    ).toEqual(
      [...REPOSITORY_GRANT]
        .map((repo) => repo.fullName)
        .sort((left, right) => left.localeCompare(right)),
    );
    expect(stateOf('example-org/almanac')).toBe('grant-only');
  });

  test('each row says which of the three it is', () => {
    // An App deploys from `infra`; `site` has a row and no App; `ledger` is only a grant.
    expect(stateOf('example-org/infra')).toBe('deploys');
    expect(stateOf('example-org/site')).toBe('connected');
    expect(stateOf('example-org/ledger')).toBe('grant-only');
  });

  test("the grant's own row-exists flag never decides a row", () => {
    // `rowExists` says a row exists, not that an App deploys from it.
    const grantOnly = repositoryChoices(
      [],
      [
        {
          repositoryId: '1',
          fullName: 'example-org/site',
          defaultBranch: 'main',
          cloneUrl: 'https://vcs.example/example-org/site.git',
          rowExists: true,
        },
      ],
    );
    expect(grantOnly[0]?.state).toBe('grant-only');
  });

  test('a repository on both lists is read off the connection', () => {
    expect(
      REPOSITORY_GRANT.find((repo) => repo.fullName === 'example-org/site')
        ?.rowExists,
    ).toBe(true);
    expect(stateOf('example-org/site')).toBe('connected');
  });
});

describe('what the picker says', () => {
  const markup = renderToStaticMarkup(
    <RepoPicker
      repos={choices}
      selected="example-org/infra"
      onSelect={() => {}}
    />,
  );

  test('the state of every row is on the row', () => {
    expect(markup).toContain('already deploys');
    expect(markup).toContain('connected');
    expect(markup).toContain('connects on Deploy');
  });

  test('selecting is stated to write nothing', () => {
    expect(markup).toContain('writes nothing');
  });

  test('an empty grant names what to do about it', () => {
    const empty = renderToStaticMarkup(
      <RepoPicker repos={[]} selected={null} onSelect={() => {}} />,
    );
    expect(empty).toContain('grants this installation no repositories');
  });
});
