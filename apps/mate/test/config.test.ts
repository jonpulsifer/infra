import { describe, expect, test } from 'bun:test';
import {
  readBrainConfig,
  readConfig,
  readSandboxConfig,
} from '../src/config.ts';
import { TTL_MS } from '../src/lease.ts';

const minimal = {
  DISCORD_TOKEN: 'token',
  MATE_GUILD_ID: '1509024936717455381',
  MATE_ALLOWED_USER_IDS: '308072071949320204',
  MATE_ALLOWED_CHANNEL_IDS: '1509024937422356532, 1509024937422356533',
};

describe('config from the environment', () => {
  test('applies the contract defaults', () => {
    const config = readConfig(minimal);
    expect(config.quietMs).toBe(30 * 60_000);
    expect(config.maxTurnsPerThread).toBe(30);
    expect(config.maxTurnsPerDay).toBe(120);
    expect(config.maxConcurrent).toBe(3);
    expect(config.maxSandboxes).toBe(2);
    expect(config.port).toBe(8080);
    expect(config.sessionFile).toBeNull();
    expect([...config.allowedChannelIds]).toEqual([
      '1509024937422356532',
      '1509024937422356533',
    ]);
  });

  test('refuses a missing token, an empty allowlist, and a non-snowflake id', () => {
    expect(() => readConfig({ ...minimal, DISCORD_TOKEN: '' })).toThrow(
      'DISCORD_TOKEN is required',
    );
    expect(() =>
      readConfig({ ...minimal, MATE_ALLOWED_USER_IDS: ' , ' }),
    ).toThrow('MATE_ALLOWED_USER_IDS is empty');
    expect(() =>
      readConfig({ ...minimal, MATE_ALLOWED_CHANNEL_IDS: 'general' }),
    ).toThrow('non-snowflake');
  });

  test('refuses a non-positive number', () => {
    expect(() => readConfig({ ...minimal, MATE_QUIET_MINUTES: '0' })).toThrow(
      'MATE_QUIET_MINUTES',
    );
    expect(() =>
      readConfig({ ...minimal, MATE_MAX_CONCURRENT: 'three' }),
    ).toThrow('MATE_MAX_CONCURRENT');
    expect(() => readConfig({ ...minimal, MATE_MAX_SANDBOXES: '0' })).toThrow(
      'MATE_MAX_SANDBOXES',
    );
  });

  test('the sandbox cap is its own knob, apart from the running turns', () => {
    const config = readConfig({
      ...minimal,
      MATE_MAX_CONCURRENT: '4',
      MATE_MAX_SANDBOXES: '1',
    });
    expect(config.maxConcurrent).toBe(4);
    expect(config.maxSandboxes).toBe(1);
  });

  test('answers threads with the stub unless told otherwise', () => {
    expect(readConfig(minimal).sandboxes).toEqual({ mode: 'stub' });
    expect(() =>
      readConfig({ ...minimal, MATE_SANDBOXES: 'kubernetes' }),
    ).toThrow('MATE_SANDBOXES must be stub or kube');
  });

  test('the slack surface is off unless both of its tokens are set', () => {
    expect(readConfig(minimal).slack).toBeNull();
    expect(() =>
      readConfig({ ...minimal, MATE_SLACK_BOT_TOKEN: 'xoxb' }),
    ).toThrow('MATE_SLACK_APP_TOKEN is required');
    const slack = {
      ...minimal,
      MATE_SLACK_BOT_TOKEN: 'xoxb',
      MATE_SLACK_APP_TOKEN: 'xapp',
      MATE_SLACK_TEAM_ID: 'TAR78LS82',
      MATE_SLACK_ALLOWED_USER_IDS: 'UAR78LSKC',
      MATE_SLACK_ALLOWED_CHANNEL_IDS: 'CARBAMA05, C062BS4GADR',
    };
    expect(readConfig(slack).slack).toEqual({
      botToken: 'xoxb',
      appToken: 'xapp',
      teamId: 'TAR78LS82',
      allowedUserIds: new Set(['UAR78LSKC']),
      allowedChannelIds: new Set(['CARBAMA05', 'C062BS4GADR']),
    });
    expect(() =>
      readConfig({ ...slack, MATE_SLACK_ALLOWED_CHANNEL_IDS: 'general' }),
    ).toThrow('non-Slack id');
  });

  test('kube mode needs a harness image and takes the sandbox defaults', () => {
    expect(() => readConfig({ ...minimal, MATE_SANDBOXES: 'kube' })).toThrow(
      'MATE_SANDBOX_IMAGE is required',
    );
    const kube = {
      ...minimal,
      MATE_SANDBOXES: 'kube',
      MATE_SANDBOX_IMAGE: 'ghcr.io/jonpulsifer/mate-sandbox:latest',
    };
    expect(readConfig(kube).sandboxes).toEqual({
      mode: 'kube',
      sandbox: {
        image: 'ghcr.io/jonpulsifer/mate-sandbox:latest',
        runtimeClass: 'kata-clh',
        namespace: null,
        checkoutRepo: 'https://github.com/jonpulsifer/infra',
        checkoutRef: 'main',
        turnTimeoutMs: 45 * 60_000,
        spares: 0,
        vault: null,
        github: false,
        kubeServiceAccount: null,
        kubeContext: 'cluster',
        kubePeers: [],
        kthx: {
          origin: null,
          sitesSecret: 'mate-kthx-sites',
        },
        switchboard: null,
      },
      brain: {
        model: 'opencode-go/qwen3.8-max',
        thinking: 'medium',
        modelKeyFile: '/var/run/mate/opencode/api-key',
        databaseUrl: null,
        databaseCaFile: '/var/run/mate/db-ca/ca.crt',
        kthxMcp: null,
        profileRoot: null,
        sessionRetentionDays: 14,
      },
      githubApp: null,
      sshKeyFile: null,
    });
    expect(() => readConfig({ ...kube, MATE_TURN_MINUTES: '0' })).toThrow(
      'MATE_TURN_MINUTES',
    );
    expect(() =>
      readConfig({ ...kube, MATE_TURN_MINUTES: String(TTL_MS / 60_000) }),
    ).toThrow('must be under the sandbox TTL');
  });

  test('a sandbox reaches its vault only once a Secret names one', () => {
    const kube = {
      ...minimal,
      MATE_SANDBOXES: 'kube',
      MATE_SANDBOX_IMAGE: 'ghcr.io/jonpulsifer/mate-sandbox:latest',
    };
    expect(readSandboxConfig(kube).vault).toBeNull();
    expect(
      readSandboxConfig({ ...kube, MATE_CONNECT_SECRET: 'mate-onepassword' })
        .vault,
    ).toEqual({
      connectHost:
        'http://onepassword-connect.external-secrets.svc.cluster.local:8080',
      connectSecret: 'mate-onepassword',
    });
  });

  test('a sandbox can ring the owner only once a switchboard URL is set', () => {
    const kube = {
      ...minimal,
      MATE_SANDBOXES: 'kube',
      MATE_SANDBOX_IMAGE: 'ghcr.io/jonpulsifer/mate-sandbox:latest',
    };
    expect(readSandboxConfig(kube).switchboard).toBeNull();
    expect(
      readSandboxConfig({ ...kube, MATE_SWITCHBOARD_SECRET: 'ring' })
        .switchboard,
    ).toBeNull();
    expect(
      readSandboxConfig({
        ...kube,
        MATE_SWITCHBOARD_URL:
          ' http://switchboard.elevenlabs.svc.cluster.local:8080 ',
      }).switchboard,
    ).toEqual({
      url: 'http://switchboard.elevenlabs.svc.cluster.local:8080',
      secret: 'mate-switchboard',
    });
    expect(
      readSandboxConfig({
        ...kube,
        MATE_SWITCHBOARD_URL: 'http://switchboard:8080',
        MATE_SWITCHBOARD_SECRET: 'ring',
      }).switchboard,
    ).toEqual({ url: 'http://switchboard:8080', secret: 'ring' });
  });

  test('the GitHub App is off until an id is set, and is never on the sandbox config', () => {
    const kube = {
      ...minimal,
      MATE_SANDBOXES: 'kube',
      MATE_SANDBOX_IMAGE: 'ghcr.io/jonpulsifer/mate-sandbox:latest',
    };
    const off = readConfig(kube).sandboxes;
    expect(off.mode === 'kube' && off.githubApp).toBeNull();
    expect(readSandboxConfig(kube).github).toBe(false);

    const on = readConfig({ ...kube, MATE_GITHUB_APP_ID: '334190' }).sandboxes;
    expect(on.mode === 'kube' && on.githubApp).toEqual({
      appId: '334190',
      keyFile: '/var/run/mate/github-app/private-key',
      owner: 'jonpulsifer',
      repo: 'infra',
    });
    // The sandbox gets the flag and never the App key.
    expect(
      readSandboxConfig({ ...kube, MATE_GITHUB_APP_ID: '334190' }).github,
    ).toBe(true);
    expect(
      Object.keys(
        readSandboxConfig({ ...kube, MATE_GITHUB_APP_ID: '334190' }),
      ).some((key) => /key|app/i.test(key)),
    ).toBe(false);

    // A turn could outlive its hour-long installation token.
    expect(() =>
      readConfig({
        ...kube,
        MATE_GITHUB_APP_ID: '334190',
        MATE_TURN_MINUTES: '55',
      }),
    ).toThrow('while a GitHub App is configured');
  });

  test('kthx is two independent halves, each off until its URL is set', () => {
    const kube = {
      ...minimal,
      MATE_SANDBOXES: 'kube',
      MATE_SANDBOX_IMAGE: 'ghcr.io/jonpulsifer/mate-sandbox:latest',
    };
    const url = 'http://spindrift.spindrift.svc.cluster.local:3000/mcp';
    const halves = (env: Record<string, string>) => {
      const choice = readConfig(env).sandboxes;
      if (choice.mode !== 'kube') throw new Error('expected kube mode');
      return { cli: choice.sandbox.kthx, mcp: choice.brain.kthxMcp };
    };
    expect(halves(kube)).toEqual({
      cli: { origin: null, sitesSecret: 'mate-kthx-sites' },
      mcp: null,
    });

    // The CLI half alone, with the origin normalised the way the CLI does it.
    expect(
      halves({
        ...kube,
        MATE_KTHX_ORIGIN: ' https://kthx.example.test/// ',
        MATE_KTHX_SITES_SECRET: 'other-sites',
      }),
    ).toEqual({
      cli: { origin: 'https://kthx.example.test', sitesSecret: 'other-sites' },
      mcp: null,
    });

    // The MCP half alone: mate holds the token, and the sandbox sees none of it.
    expect(
      halves({ ...kube, MATE_KTHX_MCP_URL: url, KTHX_AGENT_TOKEN: 'kthx_a' }),
    ).toEqual({
      cli: { origin: null, sitesSecret: 'mate-kthx-sites' },
      mcp: { url, token: 'kthx_a' },
    });

    for (const bad of ['kthx.example.test', 'ftp://kthx.example.test', ':']) {
      expect(() =>
        readSandboxConfig({ ...kube, MATE_KTHX_ORIGIN: bad }),
      ).toThrow('MATE_KTHX_ORIGIN must be an http(s) URL');
      expect(() => readConfig({ ...kube, MATE_KTHX_MCP_URL: bad })).toThrow(
        'MATE_KTHX_MCP_URL must be an http(s) URL',
      );
    }
  });

  // A spare holds a whole sandbox's memory.
  test('keeps no warm spares unless a number is given', () => {
    const kube = {
      ...minimal,
      MATE_SANDBOXES: 'kube',
      MATE_SANDBOX_IMAGE: 'ghcr.io/jonpulsifer/mate-sandbox:latest',
    };
    const read = (env: Record<string, string>) =>
      readConfig(env).sandboxes as { sandbox: { spares: number } };
    expect(read(kube).sandbox.spares).toBe(0);
    expect(read({ ...kube, MATE_SPARES: '1' }).sandbox.spares).toBe(1);
    expect(read({ ...kube, MATE_SPARES: '0' }).sandbox.spares).toBe(0);
    expect(() => readConfig({ ...kube, MATE_SPARES: '-1' })).toThrow(
      'MATE_SPARES',
    );
  });

  test('the model is provider/model, and qwen3.8-max unless told otherwise', () => {
    expect(readBrainConfig({}).model).toBe('opencode-go/qwen3.8-max');
    expect(
      readBrainConfig({ MATE_MODEL: ' opencode-go/qwen3.8-flash ' }).model,
    ).toBe('opencode-go/qwen3.8-flash');
    for (const bad of ['qwen3.8-max', '/qwen', 'opencode-go/', 'a b/c']) {
      expect(() => readBrainConfig({ MATE_MODEL: bad })).toThrow(
        'MATE_MODEL must be provider/model',
      );
    }
  });

  test("the thinking level is one of pi's, medium unless told otherwise", () => {
    expect(readBrainConfig({}).thinking).toBe('medium');
    expect(readBrainConfig({ MATE_THINKING: 'xhigh' }).thinking).toBe('xhigh');
    expect(() => readBrainConfig({ MATE_THINKING: 'loud' })).toThrow(
      'MATE_THINKING must be one of',
    );
  });

  test('a setting that moved into mate names its replacement', () => {
    expect(() =>
      readConfig({ ...minimal, MATE_SANDBOX_MODEL: 'opencode-go/x' }),
    ).toThrow('MATE_SANDBOX_MODEL is no longer read; set MATE_MODEL');
    expect(() =>
      readConfig({ ...minimal, MATE_OPENCODE_SECRET: 'mate-opencode' }),
    ).toThrow(
      'MATE_OPENCODE_SECRET is no longer read; set MATE_MODEL_KEY_FILE',
    );
    expect(() => readBrainConfig({ MATE_SANDBOX_MODEL: 'x/y' })).toThrow(
      'MATE_MODEL',
    );
  });

  test('kube mode without a database URL boots with the store down', () => {
    const kube = {
      ...minimal,
      MATE_SANDBOXES: 'kube',
      MATE_SANDBOX_IMAGE: 'ghcr.io/jonpulsifer/mate-sandbox:latest',
    };
    const off = readConfig(kube).sandboxes;
    expect(off.mode === 'kube' && off.brain.databaseUrl).toBeNull();
    const on = readConfig({
      ...kube,
      DATABASE_URL: ' postgresql://app@mate-db-rw.mate:5432/app ',
      MATE_DB_CA_FILE: '/etc/ca.crt',
    }).sandboxes;
    expect(on.mode === 'kube' && on.brain).toMatchObject({
      databaseUrl: 'postgresql://app@mate-db-rw.mate:5432/app',
      databaseCaFile: '/etc/ca.crt',
    });
  });

  test('the kthx tools need both the MCP URL and the agent token', () => {
    const url = 'http://spindrift.spindrift.svc.cluster.local:3000/mcp';
    expect(readBrainConfig({ MATE_KTHX_MCP_URL: url }).kthxMcp).toBeNull();
    expect(readBrainConfig({ KTHX_AGENT_TOKEN: 'kthx_a' }).kthxMcp).toBeNull();
    expect(
      readBrainConfig({ MATE_KTHX_MCP_URL: url, KTHX_AGENT_TOKEN: ' kthx_a\n' })
        .kthxMcp,
    ).toEqual({ url, token: 'kthx_a' });
    expect(() =>
      readBrainConfig({
        MATE_KTHX_MCP_URL: 'spindrift',
        KTHX_AGENT_TOKEN: 'a',
      }),
    ).toThrow('MATE_KTHX_MCP_URL must be an http(s) URL');
  });

  test('sessions are kept 14 days, and 0 keeps them for good', () => {
    expect(readBrainConfig({}).sessionRetentionDays).toBe(14);
    expect(
      readBrainConfig({ MATE_SESSION_RETENTION_DAYS: '0' })
        .sessionRetentionDays,
    ).toBe(0);
    expect(
      readBrainConfig({ MATE_SESSION_RETENTION_DAYS: '30' })
        .sessionRetentionDays,
    ).toBe(30);
    expect(() =>
      readBrainConfig({ MATE_SESSION_RETENTION_DAYS: '-1' }),
    ).toThrow('MATE_SESSION_RETENTION_DAYS');
  });

  test('the profile and the key file have their own paths', () => {
    expect(
      readBrainConfig({
        MATE_PROFILE_DIR: '/app',
        MATE_MODEL_KEY_FILE: '/run/key',
      }),
    ).toMatchObject({ profileRoot: '/app', modelKeyFile: '/run/key' });
  });
});
