export type Registration = 'registered' | 'rejected' | 'unregistered';
export type EndpointState = 'online' | 'offline' | 'unknown';

/** What the board reads from Asterisk's /metrics, which ARI does not carry. */
export interface PbxMetrics {
  /** Outbound registration state by voip.ms sub-account. */
  readonly registrations: Record<string, Registration>;
  /** Endpoint state by PJSIP endpoint name. */
  readonly endpoints: Record<string, EndpointState>;
  readonly version?: string;
  readonly uptimeSeconds?: number;
}

const SAMPLE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)/;
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

function labels(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of (raw ?? '').matchAll(LABEL)) {
    out[match[1] as string] = (match[2] as string).replace(/\\(.)/g, '$1');
  }
  return out;
}

// res_prometheus documents 0=Unregistered, 1=Registered, 2=Rejected.
const REGISTRATION: Record<string, Registration> = {
  '0': 'unregistered',
  '1': 'registered',
  '2': 'rejected',
};

// res_prometheus documents 0=unknown, 1=offline, 2=online.
const ENDPOINT: Record<string, EndpointState> = {
  '0': 'unknown',
  '1': 'offline',
  '2': 'online',
};

/** Parses the Prometheus text format, keeping only the series named above. */
export function parseMetrics(text: string): PbxMetrics {
  const registrations: Record<string, Registration> = {};
  const endpoints: Record<string, EndpointState> = {};
  let version: string | undefined;
  let uptimeSeconds: number | undefined;
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const sample = SAMPLE.exec(line);
    if (!sample) continue;
    const [, name, rawLabels, value = ''] = sample;
    const l = labels(rawLabels);
    switch (name) {
      case 'asterisk_pjsip_outbound_registration_status': {
        // username is the registration's client_uri, sip:<account>@<server>.
        const account = /^sips?:([^@]+)@/.exec(l.username ?? '')?.[1];
        const state = REGISTRATION[value];
        if (account && state) registrations[account] = state;
        break;
      }
      case 'asterisk_endpoints_state': {
        const state = ENDPOINT[value];
        if (l.resource && state) endpoints[l.resource] = state;
        break;
      }
      case 'asterisk_core_properties':
        version = l.version || version;
        break;
      case 'asterisk_core_uptime_seconds': {
        const seconds = Number(value);
        if (Number.isFinite(seconds)) uptimeSeconds = seconds;
        break;
      }
    }
  }
  return { registrations, endpoints, version, uptimeSeconds };
}
