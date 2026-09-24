export type Fields = Record<string, unknown>;

export interface Log {
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
}

function line(level: string, msg: string, fields: Fields | undefined): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  });
}

export const jsonLog: Log = {
  info: (msg, fields) => console.log(line('info', msg, fields)),
  warn: (msg, fields) => console.warn(line('warn', msg, fields)),
  error: (msg, fields) => console.error(line('error', msg, fields)),
};
