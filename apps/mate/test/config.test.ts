import { describe, expect, test } from 'bun:test';
import { readConfig, readSandboxConfig } from '../src/config.ts';
import { TTL_MS } from '../src/sandboxes.ts';

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
        secret: 'mate-opencode',
        checkoutRepo: 'https://github.com/jonpulsifer/infra',
        checkoutRef: 'main',
        model: 'opencode-go/qwen3.8-flash',
        turnTimeoutMs: 45 * 60_000,
        spares: 0,
        vault: null,
        github: false,
        kubeServiceAccount: null,
        kthx: {
          origin: null,
          sitesSecret: 'mate-kthx-sites',
          mcpUrl: null,
          agentSecret: 'mate-kthx-agent',
        },
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
    expect(readSandboxConfig(kube).kthx).toEqual({
      origin: null,
      sitesSecret: 'mate-kthx-sites',
      mcpUrl: null,
      agentSecret: 'mate-kthx-agent',
    });

    // The CLI half alone, with the origin normalised the way the CLI does it.
    expect(
      readSandboxConfig({
        ...kube,
        MATE_KTHX_ORIGIN: ' https://kthx.example.test/// ',
        MATE_KTHX_SITES_SECRET: 'other-sites',
      }).kthx,
    ).toEqual({
      origin: 'https://kthx.example.test',
      sitesSecret: 'other-sites',
      mcpUrl: null,
      agentSecret: 'mate-kthx-agent',
    });

    // The MCP half alone.
    expect(
      readSandboxConfig({
        ...kube,
        MATE_KTHX_MCP_URL:
          'http://spindrift.spindrift.svc.cluster.local:3000/mcp',
        MATE_KTHX_AGENT_SECRET: 'other-agent',
      }).kthx,
    ).toEqual({
      origin: null,
      sitesSecret: 'mate-kthx-sites',
      mcpUrl: 'http://spindrift.spindrift.svc.cluster.local:3000/mcp',
      agentSecret: 'other-agent',
    });

    for (const bad of ['kthx.example.test', 'ftp://kthx.example.test', ':']) {
      expect(() =>
        readSandboxConfig({ ...kube, MATE_KTHX_ORIGIN: bad }),
      ).toThrow('MATE_KTHX_ORIGIN must be an http(s) URL');
      expect(() =>
        readSandboxConfig({ ...kube, MATE_KTHX_MCP_URL: bad }),
      ).toThrow('MATE_KTHX_MCP_URL must be an http(s) URL');
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
});
