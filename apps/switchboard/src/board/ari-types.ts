// The slice of the ARI data model (Asterisk 22, rest-api/api-docs) the board
// reads. Every field is optional here because the board must survive an
// event it only half understands.

export interface AriCallerId {
  readonly name?: string;
  readonly number?: string;
}

export interface AriDialplan {
  readonly context?: string;
  readonly exten?: string;
  readonly priority?: number;
  readonly app_name?: string;
  readonly app_data?: string;
}

export interface AriChannel {
  readonly id: string;
  readonly name: string;
  readonly state?: string;
  readonly caller?: AriCallerId;
  readonly connected?: AriCallerId;
  readonly dialplan?: AriDialplan;
  readonly creationtime?: string;
  /** The variables ari.conf's `channelvars` names, on every channel event. */
  readonly channelvars?: Readonly<Record<string, string>>;
}

export interface AriBridge {
  readonly id: string;
  readonly channels?: readonly string[];
}

export interface AriEndpoint {
  readonly technology?: string;
  readonly resource: string;
  readonly state?: string;
}

export interface AriContactInfo {
  readonly aor?: string;
  readonly contact_status?: string;
  readonly roundtrip_usec?: string;
}

export interface AriEvent {
  readonly type: string;
  readonly timestamp?: string;
  readonly channel?: AriChannel;
  /** Dial: the channel being dialled. */
  readonly peer?: AriChannel;
  /** Dial: the channel that dialled, absent for an originate. */
  readonly caller?: AriChannel;
  readonly dialstatus?: string;
  readonly variable?: string;
  readonly value?: string;
  readonly cause?: number;
  readonly cause_txt?: string;
  readonly bridge?: AriBridge;
  readonly endpoint?: AriEndpoint;
  readonly contact_info?: AriContactInfo;
}

/** ARI dates end in `+0000`; ISO 8601 wants `+00:00`. */
export function parseAriTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  return Number.isFinite(ms) ? ms : undefined;
}
