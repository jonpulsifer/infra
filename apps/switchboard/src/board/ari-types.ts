// The slice of the ARI data model (Asterisk 22, rest-api/api-docs) the board
// reads from ARI's lists. Every field is optional here because the board must
// survive an object it only half understands.

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
  /** The variables ari.conf's `channelvars` names, as of the last step. */
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

/** ARI dates end in `+0000`; ISO 8601 wants `+00:00`. */
export function parseAriTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  return Number.isFinite(ms) ? ms : undefined;
}
