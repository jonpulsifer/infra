// `hourCycle: 'h23'`, because `hour12: false` can select h24, which writes
// midnight as 24:00.
const HOUR_MINUTE = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function clockTime(date: Date): string {
  return HOUR_MINUTE.format(date);
}

export function clockTimeFromEpochSeconds(epochSeconds: number): string {
  return clockTime(new Date(epochSeconds * 1000));
}
