import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// import.meta.url keeps the ~/.dotfiles symlink, so resolve it before walking up.
const REPO = resolve(
  dirname(realpathSync(fileURLToPath(import.meta.url))),
  '../../../..',
);
const KTHX_TOKEN = 'op://homelab/workstation kthx agent token/credential';

// A load error aborts `pi -p`, so a missing file skips its servers.
function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(join(REPO, path), 'utf8'));
  } catch {
    return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  const fleet = readJson('terraform/network/tailscale/fleet.tf.json');
  const tailnet = fleet?.locals?.fleet?.tailnet;
  if (typeof tailnet === 'string' && tailnet) {
    pi.registerMcpServer('weather', {
      url: `https://weather.${tailnet}/mcp`,
      exposure: 'direct',
      timeout: 15,
      description: 'Canadian weather, Tempest stations, alerts and climate',
    });
  }
  // `&&` fails the header when op fails, where a bare $(...) sends `Bearer `.
  pi.registerMcpServer('kthx', {
    url: 'https://spindrift-control.lolwtf.dev/mcp',
    headers: {
      Authorization: `!t=$(op read '${KTHX_TOKEN}') && printf 'Bearer %s' "$t"`,
    },
    exposure: 'deferred',
    timeout: 60,
    description: 'kthx built apps, one tool per console command',
  });
  const servers = readJson('.mcp.json')?.mcpServers ?? {};
  for (const [name, server] of Object.entries(servers)) {
    pi.registerMcpServer(name, { ...(server as object), exposure: 'deferred' });
  }
}
