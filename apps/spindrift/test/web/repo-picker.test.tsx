/**
 * The repository picker lists the GitHub grant (§20, story 24).
 *
 * `listRepositories` answers with two lists — the rows Spindrift holds and the
 * repositories GitHub currently grants — and the defect this pins is a picker
 * that renders the first and drops the second: on a fresh installation, where
 * the operator has granted repositories and connected none, that reads "no
 * repositories" beside a GitHub App that is working.
 *
 * Each list carries its own boolean about Spindrift — `alreadyDeploys` on a
 * connection, `rowExists` on a grant entry — which is why the state on each row
 * is derived here rather than read off either one.
 */
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
    // The whole point: `options` is empty on a fresh installation and the
    // grant is not.
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
    // An App deploys from `infra`; `site` has a row and no App; `ledger` is
    // only a grant. Three different presses, so three different rows.
    expect(stateOf('example-org/infra')).toBe('deploys');
    expect(stateOf('example-org/site')).toBe('connected');
    expect(stateOf('example-org/ledger')).toBe('grant-only');
  });

  test("the grant's own row-exists flag never decides a row", () => {
    // A grant entry knows only that Spindrift holds a row; whether an App
    // deploys from it is the connection's own fact. Reading the first as the
    // second is how a connected repository with no App reads as one that has
    // one.
    const grantOnly = repositoryChoices(
      [],
      [
        {
          repositoryId: '1',
          fullName: 'example-org/site',
          defaultBranch: 'main',
          rowExists: true,
        },
      ],
    );
    expect(grantOnly[0]?.state).toBe('grant-only');
  });

  test('a repository on both lists is read off the connection', () => {
    // `example-org/site` has a row and no App: the grant says a row exists and
    // the connection says nothing deploys from it. Only the second is an answer
    // to the question the row is asking.
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
    // The promise the draft makes — "Nothing has been created" — is only true
    // if browsing repositories does not open a pull request per look.
    expect(markup).toContain('writes nothing');
  });

  test('an empty grant names what to do about it', () => {
    const empty = renderToStaticMarkup(
      <RepoPicker repos={[]} selected={null} onSelect={() => {}} />,
    );
    expect(empty).toContain('grants this installation no repositories');
  });
});
