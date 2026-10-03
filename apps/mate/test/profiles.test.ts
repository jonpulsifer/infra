import { describe, expect, test } from 'bun:test';
import { ConfigError } from '../src/config.ts';
import {
  type BaseTool,
  type Grants,
  investigatorPreamble,
  lists,
  type Network,
  operatorPreamble,
  PROFILES,
  type Profile,
  profileTag,
  strayTag,
  sweepable,
  validateProfiles,
} from '../src/profiles.ts';

const LIMITS = { turnTimeoutMs: 45 * 60_000 };
const OPTIONS = { workspace: '/workspace', checkoutRef: 'main' };
const operator = PROFILES.get('operator') as Profile;
const investigator = PROFILES.get('investigator') as Profile;
const custodian = PROFILES.get('custodian') as Profile;

/** PROFILES with `profile` added, or put in place of the one with its key. */
function declared(
  profile: Profile,
  key = profile.id,
): ReadonlyMap<string, Profile> {
  return new Map([...PROFILES, [key, profile]]);
}

function refused(profiles: ReadonlyMap<string, Profile>, id: string): void {
  const run = () => validateProfiles(profiles, LIMITS);
  expect(run).toThrow(ConfigError);
  expect(run).toThrow(`profile ${id}`);
}

const reader = (grants: Partial<Grants>, mcp: string[] = []): Profile => ({
  ...investigator,
  grants: { ...investigator.grants, ...grants },
  tools: { base: investigator.tools.base, mcp: ['weather_*', ...mcp] },
});

describe('validateProfiles', () => {
  test('passes the declared profiles', () => {
    expect(() => validateProfiles(PROFILES, LIMITS)).not.toThrow();
  });

  test('refuses a key that is not the id', () => {
    refused(
      declared({ ...investigator, id: 'looker' }, 'investigator'),
      'investigator',
    );
  });

  test.each(['Investigator', '1st', 'a_b', `a${'b'.repeat(31)}`])(
    'refuses the id %s, which is no label value',
    (id) => {
      refused(declared({ ...investigator, id }), id);
    },
  );

  test('refuses a set with no default profile', () => {
    const profiles = new Map([...PROFILES].filter(([id]) => id !== 'operator'));
    const run = () => validateProfiles(profiles, LIMITS);
    expect(run).toThrow(ConfigError);
    expect(run).toThrow('no profile operator');
  });

  test('refuses a default profile that is not interactive', () => {
    refused(
      declared({ ...operator, mode: 'automation', budget: custodian.budget }),
      'operator',
    );
  });

  test.each<[BaseTool[]]>([
    [['read', 'shell' as BaseTool]],
    [['read', 'read']],
  ])('refuses the base tools %p', (base) => {
    refused(
      declared({ ...investigator, tools: { base, mcp: ['weather_*'] } }),
      'investigator',
    );
  });

  test.each(['*', '_*', 'deploy', 'kthx_', 'Kthx_*'])(
    'refuses the MCP pattern %s',
    (pattern) => {
      refused(
        declared({
          ...operator,
          tools: { base: operator.tools.base, mcp: [pattern] },
        }),
        'operator',
      );
    },
  );

  test('refuses turnMinutes above MATE_TURN_MINUTES', () => {
    refused(
      declared({
        ...investigator,
        budget: { ...investigator.budget, turnMinutes: 46 },
      }),
      'investigator',
    );
  });

  test('refuses an interactive profile with turnsPerDay', () => {
    refused(
      declared({
        ...investigator,
        budget: { ...investigator.budget, turnsPerDay: 5 },
      }),
      'investigator',
    );
  });

  test('refuses a job profile without turnsPerDay', () => {
    refused(
      declared({
        ...custodian,
        budget: { ...custodian.budget, turnsPerDay: null },
      }),
      'custodian',
    );
  });

  test('refuses a network no policy selects', () => {
    refused(
      declared({
        ...investigator,
        sandbox: { network: 'mate-sandbox-world' as Network, spares: false },
      }),
      'investigator',
    );
  });

  test.each<[string, Profile]>([
    ['the admin identity', reader({ kube: 'admin' })],
    ['a GitHub token', reader({ github: true })],
    ['an SSH key', reader({ ssh: true })],
    ['a talosconfig', reader({ talos: true })],
    ['the kthx sites file', reader({ kthxSites: true })],
    ['the ring token', reader({ switchboard: true })],
    ['1Password Connect', reader({ vault: true })],
    ['kthx tools', reader({}, ['kthx_*'])],
    ['a kthx tool by name', reader({}, ['kthx_listApps'])],
  ])('refuses the reader network with %s', (_, profile) => {
    refused(declared(profile), 'investigator');
  });

  test('refuses the reader identity on mate-sandbox', () => {
    refused(
      declared({
        ...investigator,
        sandbox: { network: 'mate-sandbox', spares: false },
      }),
      'investigator',
    );
  });

  test('refuses spares on a profile whose pod is not the default one', () => {
    refused(
      declared({
        ...investigator,
        sandbox: { network: 'mate-sandbox-reader', spares: true },
      }),
      'investigator',
    );
  });
});

describe('the declared profiles', () => {
  test('operator holds every grant, and investigator only the reader identity', () => {
    expect(operator.grants).toEqual({
      kube: 'admin',
      github: true,
      ssh: true,
      talos: true,
      kthxSites: true,
      switchboard: true,
      vault: true,
    });
    expect(investigator.grants).toEqual({
      kube: 'reader',
      github: false,
      ssh: false,
      talos: false,
      kthxSites: false,
      switchboard: false,
      vault: false,
    });
    expect(custodian.grants).toEqual(operator.grants);
  });

  test('investigator lists weather tools and no kthx tool', () => {
    expect(lists(investigator, 'kthx_deleteApp')).toBe(false);
    expect(lists(investigator, 'weather_forecast')).toBe(true);
    expect(lists(investigator, 'bash')).toBe(true);
    expect(lists(operator, 'kthx_deleteApp')).toBe(true);
  });

  test('retention sweeps only the profiles with the default grants', () => {
    expect(sweepable()).toEqual(['operator', 'custodian']);
  });
});

describe('profileTag', () => {
  test.each([
    '+investigator check',
    '+investigator, check',
    '+investigator: check',
    '+Investigator check',
    '+INVESTIGATOR check',
    '+investigator\u2014check',
    '\uff0binvestigator check',
  ])('reads %p', (text) => {
    expect(profileTag(text)).toEqual({ id: 'investigator', text: 'check' });
  });

  test.each([
    ["+investigator's view", 'investigator'],
    ['+Nope x', 'nope'],
    ['+LGTM', 'lgtm'],
    ['+investigatorx', 'investigatorx'],
  ])('reads %p as +%s, so a mistake is refused', (text, id) => {
    expect(profileTag(text)?.id).toBe(id);
  });

  test.each(['+1 nice', 'c++ thing', 'can you +investigator check'])(
    'reads no tag in %p',
    (text) => {
      expect(profileTag(text)).toBeNull();
    },
  );
});

describe('strayTag', () => {
  const ids = [...PROFILES.keys()];

  test.each([
    'can you +investigator check',
    'can you +Investigator check',
    '(+investigator) check',
    'can you \uff0binvestigator check',
  ])('finds a declared tag that is not the first word in %p', (text) => {
    expect(strayTag(text, ids)).toBe('investigator');
  });

  test.each(['c++ thing', '+investigatorx', 'a+investigator'])(
    'finds none in %p',
    (text) => {
      expect(strayTag(text, ids)).toBeNull();
    },
  );
});

describe('the preambles', () => {
  test('operator keeps the text it had before profiles', () => {
    expect(operatorPreamble('Slack', OPTIONS)).toBe(
      `You are Rowbutt, the owner's coding and operations agent for this homelab, answering in a Slack thread. Your replies post to the thread as Markdown; keep them short.

Your tools run in this thread's own sandbox, a Kata microVM on the offsite cluster, with the infra repository checked out at /workspace at \`main\`. The sandbox starts on your first tool call, which can take a minute, so answer a question that needs no files or commands without tools.

- Credentials (git push, kubectl for the offsite and folly contexts, talosctl, and ssh) exist only while a turn runs.
- \`talosctl --context <offsite|folly>\` reads Talos nodes as \`os:reader\`, which cannot read file contents or change a node. It fails against a NixOS node, and while \`~/.talos/config\` is empty.
- Background processes do not survive the end of the turn.
- The sandbox and its uncommitted work are deleted when the thread goes quiet or another thread needs the slot. Commit and push work worth keeping before the turn ends. When that happens, mate says so at the start of the next message.
- A mate restart can interrupt a running command. Its result then says it was interrupted and its outcome is unknown, so check what it did before you run it again.
- Nix work runs on the site's build host: \`ssh riptide.lolwtf.ca\` for folly, \`ssh oldschool.lolwtf.ca\` for offsite.
- Check a change with \`mise run format:check && mise run lint\`, not \`mise run check\`, which needs pwsh.
- The \`kthx_*\` tools, when listed, act on kthx built apps.`,
    );
  });

  test('investigator asks for nothing it cannot do, and explains a folly 401', () => {
    const text = investigatorPreamble('Discord', OPTIONS);
    expect(text).toContain('in a Discord thread');
    expect(text).not.toContain('Credentials (git push');
    expect(text).not.toContain('Commit and push');
    expect(text).not.toContain('`ssh ');
    expect(text).not.toContain('kthx_');
    expect(text.toLowerCase()).not.toContain('victoria-logs');
    expect(text).toContain('A 401 from folly');
  });
});
