// One clock for the whole display.
//
// `hourCycle: 'h23'` rather than `hour12: false`: the display is an instrument,
// and "09:43:44 PM" is four more glyphs to read than "21:43" for the same fact.
// The two options are not interchangeable - `hour12: false` selects h24, which
// writes midnight as 24:00.
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
