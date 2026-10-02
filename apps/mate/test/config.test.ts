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
  MATE_SANDBOX_IMAGE: 'ghcr.io/jonpulsifer/mate-sandbox:latest',
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

  test('the daily check is opt-in to an allowed Slack channel', () => {
    const slack = {
      ...minimal,
      MATE_SLACK_BOT_TOKEN: 'xoxb',
      MATE_SLACK_APP_TOKEN: 'xapp',
      MATE_SLACK_TEAM_ID: 'TAR78LS82',
      MATE_SLACK_ALLOWED_USER_IDS: 'UAR78LSKC',
      MATE_SLACK_ALLOWED_CHANNEL_IDS: 'C062BS4GADR',
    };
    expect(readConfig(minimal).custodianChannel).toBeNull();
    expect(
      readConfig({ ...slack, MATE_CUSTODIAN_CHANNEL: 'C062BS4GADR' })
        .custodianChannel,
    ).toBe('C062BS4GADR');
    expect(() =>
      readConfig({ ...slack, MATE_CUSTODIAN_CHANNEL: 'COTHER' }),
    ).toThrow('allowed Slack channel');
    expect(() =>
      readConfig({ ...minimal, MATE_CUSTODIAN_CHANNEL: 'C062BS4GADR' }),
    ).toThrow('allowed Slack channel');
  });

  test('needs a harness image and takes the sandbox defaults', () => {
    expect(() => readConfig({ ...minimal, MATE_SANDBOX_IMAGE: ' ' })).toThrow(
      'MATE_SANDBOX_IMAGE is required',
    );
    const { sandbox, brain, githubApp, sshKeyFile } = readConfig(minimal);
    expect({ sandbox, brain, githubApp, sshKeyFile }).toEqual({
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
        kubeReaderServiceAccount: null,
        kubeContext: 'cluster',
        kubePeers: [],
        kthx: {
          origin: null,
          sitesSecret: 'mate-kthx-sites',
        },
        switchboard: null,
      },
      brain: {
        model: 'openai-codex/gpt-6-sol',
        thinking: 'medium',
        fallbackModel: 'opencode-go/qwen3.8-max',
        fallbackThinking: null,
        modelKeyFile: '/var/run/mate/opencode/api-key',
        databaseUrl: null,
        databaseCaFile: '/var/run/mate/db-ca/ca.crt',
        mcpServers: [],
        profileRoot: null,
        sessionRetentionDays: 14,
      },
      githubApp: null,
      sshKeyFile: null,
    });
    expect(() => readConfig({ ...minimal, MATE_TURN_MINUTES: '0' })).toThrow(
      'MATE_TURN_MINUTES',
    );
    expect(() =>
      readConfig({ ...minimal, MATE_TURN_MINUTES: String(TTL_MS / 60_000) }),
    ).toThrow('must be under the sandbox TTL');
  });

  test('read-only profiles get a cluster account only once one is named, and never the admin', () => {
    const admin = { ...minimal, MATE_SANDBOX_KUBE_SA: 'mate-sandbox-admin' };
    expect(readSandboxConfig(admin).kubeReaderServiceAccount).toBeNull();
    expect(
      readSandboxConfig({ ...admin, MATE_SANDBOX_KUBE_READER_SA: ' ' })
        .kubeReaderServiceAccount,
    ).toBeNull();
    expect(
      readSandboxConfig({
        ...admin,
        MATE_SANDBOX_KUBE_READER_SA: ' mate-sandbox-reader ',
      }),
    ).toMatchObject({
      kubeServiceAccount: 'mate-sandbox-admin',
      kubeReaderServiceAccount: 'mate-sandbox-reader',
    });
    expect(() =>
      readSandboxConfig({
        ...admin,
        MATE_SANDBOX_KUBE_READER_SA: 'mate-sandbox-admin',
      }),
    ).toThrow(
      'MATE_SANDBOX_KUBE_READER_SA must differ from MATE_SANDBOX_KUBE_SA',
    );
  });

  test('a sandbox reaches its vault only once a Secret names one', () => {
    expect(readSandboxConfig(minimal).vault).toBeNull();
    expect(
      readSandboxConfig({ ...minimal, MATE_CONNECT_SECRET: 'mate-onepassword' })
        .vault,
    ).toEqual({
      connectHost:
        'http://onepassword-connect.external-secrets.svc.cluster.local:8080',
      connectSecret: 'mate-onepassword',
    });
  });

  test('a sandbox can ring the owner only once a switchboard URL is set', () => {
    expect(readSandboxConfig(minimal).switchboard).toBeNull();
    expect(
      readSandboxConfig({ ...minimal, MATE_SWITCHBOARD_SECRET: 'ring' })
        .switchboard,
    ).toBeNull();
    expect(
      readSandboxConfig({
        ...minimal,
        MATE_SWITCHBOARD_URL:
          ' http://switchboard.elevenlabs.svc.cluster.local:8080 ',
      }).switchboard,
    ).toEqual({
      url: 'http://switchboard.elevenlabs.svc.cluster.local:8080',
      secret: 'mate-switchboard',
    });
    expect(
      readSandboxConfig({
        ...minimal,
        MATE_SWITCHBOARD_URL: 'http://switchboard:8080',
        MATE_SWITCHBOARD_SECRET: 'ring',
      }).switchboard,
    ).toEqual({ url: 'http://switchboard:8080', secret: 'ring' });
  });

  test('the GitHub App is off until an id is set, and is never on the sandbox config', () => {
    expect(readConfig(minimal).githubApp).toBeNull();
    expect(readSandboxConfig(minimal).github).toBe(false);

    expect(
      readConfig({ ...minimal, MATE_GITHUB_APP_ID: '334190' }).githubApp,
    ).toEqual({
      appId: '334190',
      keyFile: '/var/run/mate/github-app/private-key',
      owner: 'jonpulsifer',
      repo: 'infra',
    });
    // The sandbox gets the flag and never the App key.
    expect(
      readSandboxConfig({ ...minimal, MATE_GITHUB_APP_ID: '334190' }).github,
    ).toBe(true);
    expect(
      Object.keys(
        readSandboxConfig({ ...minimal, MATE_GITHUB_APP_ID: '334190' }),
      ).some((key) => /key|app/i.test(key)),
    ).toBe(false);

    // A turn could outlive its hour-long installation token.
    expect(() =>
      readConfig({
        ...minimal,
        MATE_GITHUB_APP_ID: '334190',
        MATE_TURN_MINUTES: '55',
      }),
    ).toThrow('while a GitHub App is configured');
  });

  test('kthx is two independent halves, each off until its URL is set', () => {
    const url = 'http://spindrift.spindrift.svc.cluster.local:3000/mcp';
    const halves = (env: Record<string, string>) => {
      const config = readConfig(env);
      return { cli: config.sandbox.kthx, mcp: config.brain.mcpServers };
    };
    expect(halves(minimal)).toEqual({
      cli: { origin: null, sitesSecret: 'mate-kthx-sites' },
      mcp: [],
    });

    // The CLI half alone, with the origin normalised the way the CLI does it.
    expect(
      halves({
        ...minimal,
        MATE_KTHX_ORIGIN: ' https://kthx.example.test/// ',
        MATE_KTHX_SITES_SECRET: 'other-sites',
      }),
    ).toEqual({
      cli: { origin: 'https://kthx.example.test', sitesSecret: 'other-sites' },
      mcp: [],
    });

    // The MCP half alone: mate holds the token, and the sandbox sees none of it.
    expect(
      halves({
        ...minimal,
        MATE_KTHX_MCP_URL: url,
        KTHX_AGENT_TOKEN: 'kthx_a',
      }),
    ).toEqual({
      cli: { origin: null, sitesSecret: 'mate-kthx-sites' },
      mcp: [{ name: 'kthx', url, token: 'kthx_a' }],
    });

    for (const bad of ['kthx.example.test', 'ftp://kthx.example.test', ':']) {
      expect(() =>
        readSandboxConfig({ ...minimal, MATE_KTHX_ORIGIN: bad }),
      ).toThrow('MATE_KTHX_ORIGIN must be an http(s) URL');
      expect(() => readConfig({ ...minimal, MATE_KTHX_MCP_URL: bad })).toThrow(
        'MATE_KTHX_MCP_URL must be an http(s) URL',
      );
    }
  });

  // A spare holds a whole sandbox's memory.
  test('keeps no warm spares unless a number is given', () => {
    const spares = (env: Record<string, string>) =>
      readConfig(env).sandbox.spares;
    expect(spares(minimal)).toBe(0);
    expect(spares({ ...minimal, MATE_SPARES: '1' })).toBe(1);
    expect(spares({ ...minimal, MATE_SPARES: '0' })).toBe(0);
    expect(() => readConfig({ ...minimal, MATE_SPARES: '-1' })).toThrow(
      'MATE_SPARES',
    );
  });

  test('the model is provider/model, and gpt-6-sol unless told otherwise', () => {
    expect(readBrainConfig({}).model).toBe('openai-codex/gpt-6-sol');
    expect(
      readBrainConfig({ MATE_MODEL: ' opencode-go/qwen3.8-flash ' }).model,
    ).toBe('opencode-go/qwen3.8-flash');
    for (const bad of ['qwen3.8-max', '/qwen', 'opencode-go/', 'a b/c']) {
      expect(() => readBrainConfig({ MATE_MODEL: bad })).toThrow(
        'MATE_MODEL must be provider/model',
      );
    }
  });

  test('the fallback is qwen3.8-max unless told otherwise, and none turns it off', () => {
    expect(readBrainConfig({}).fallbackModel).toBe('opencode-go/qwen3.8-max');
    expect(
      readBrainConfig({ MATE_FALLBACK_MODEL: ' opencode-go/glm-5.1 ' })
        .fallbackModel,
    ).toBe('opencode-go/glm-5.1');
    expect(
      readBrainConfig({
        MATE_MODEL: 'opencode-go/qwen3.8-max',
        MATE_FALLBACK_MODEL: 'none',
      }).fallbackModel,
    ).toBeNull();
    for (const bad of ['qwen3.8-max', 'opencode-go/', 'None']) {
      expect(() => readBrainConfig({ MATE_FALLBACK_MODEL: bad })).toThrow(
        'MATE_FALLBACK_MODEL must be provider/model',
      );
    }
  });

  test('the fallback must differ from the model', () => {
    expect(() =>
      readBrainConfig({ MATE_MODEL: 'opencode-go/qwen3.8-max' }),
    ).toThrow('MATE_FALLBACK_MODEL must differ from MATE_MODEL');
  });

  test("the fallback's thinking level is one of pi's, or unset", () => {
    expect(readBrainConfig({}).fallbackThinking).toBeNull();
    expect(
      readBrainConfig({ MATE_FALLBACK_THINKING: 'low' }).fallbackThinking,
    ).toBe('low');
    expect(() => readBrainConfig({ MATE_FALLBACK_THINKING: 'loud' })).toThrow(
      'MATE_FALLBACK_THINKING must be one of',
    );
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

  test('without a database URL mate boots with the store down', () => {
    expect(readConfig(minimal).brain.databaseUrl).toBeNull();
    const on = readConfig({
      ...minimal,
      DATABASE_URL: ' postgresql://app@mate-db-rw.mate:5432/app ',
      MATE_DB_CA_FILE: '/etc/ca.crt',
    });
    expect(on.brain).toMatchObject({
      databaseUrl: 'postgresql://app@mate-db-rw.mate:5432/app',
      databaseCaFile: '/etc/ca.crt',
    });
  });

  test('the kthx tools need both the MCP URL and the agent token', () => {
    const url = 'http://spindrift.spindrift.svc.cluster.local:3000/mcp';
    expect(readBrainConfig({ MATE_KTHX_MCP_URL: url }).mcpServers).toEqual([]);
    expect(readBrainConfig({ KTHX_AGENT_TOKEN: 'kthx_a' }).mcpServers).toEqual(
      [],
    );
    expect(
      readBrainConfig({ MATE_KTHX_MCP_URL: url, KTHX_AGENT_TOKEN: ' kthx_a\n' })
        .mcpServers,
    ).toEqual([{ name: 'kthx', url, token: 'kthx_a' }]);
    expect(() =>
      readBrainConfig({
        MATE_KTHX_MCP_URL: 'spindrift',
        KTHX_AGENT_TOKEN: 'a',
      }),
    ).toThrow('MATE_KTHX_MCP_URL must be an http(s) URL');
  });

  test('the weather tools need only the MCP URL, and come after kthx', () => {
    const kthx = 'http://spindrift.spindrift.svc.cluster.local:3000/mcp';
    const weather = 'http://weather.weather.svc.cluster.local:8080/mcp';
    expect(
      readBrainConfig({ MATE_WEATHER_MCP_URL: weather }).mcpServers,
    ).toEqual([{ name: 'weather', url: weather, token: null }]);
    expect(
      readBrainConfig({
        MATE_KTHX_MCP_URL: kthx,
        KTHX_AGENT_TOKEN: 'kthx_a',
        MATE_WEATHER_MCP_URL: weather,
      }).mcpServers,
    ).toEqual([
      { name: 'kthx', url: kthx, token: 'kthx_a' },
      { name: 'weather', url: weather, token: null },
    ]);
    expect(() => readBrainConfig({ MATE_WEATHER_MCP_URL: 'weather' })).toThrow(
      'MATE_WEATHER_MCP_URL must be an http(s) URL',
    );
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
