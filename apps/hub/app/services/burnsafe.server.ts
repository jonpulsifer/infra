import {
  BURNSAFE_URL,
  type BurnRestriction,
  parseBurnSafe,
  parseCountyMap,
} from '~/lib/burnsafe';

// The page changes twice a day (8 am and 2 pm), so a 10 minute poll is at
// most 10 minutes late and costs the province 144 requests a day.
const POLL_INTERVAL = 10 * 60_000; // ms
const TIMEOUT = 10_000; // ms

/**
 * Polls the BurnSafe page for the counties named in BURNSAFE_COUNTIES
 * (`<station id>=<county>,...`). Nothing is fetched when it is unset. A failed
 * fetch keeps the last restrictions, which the page dates itself.
 */
class BurnSafePoller {
  private stationCounties = parseCountyMap(process.env.BURNSAFE_COUNTIES ?? '');
  private counties = new Map<string, BurnRestriction>();
  private firstTick: Promise<void> | null = null;

  async byStation(): Promise<Map<number, BurnRestriction>> {
    if (this.stationCounties.size === 0) return new Map();
    if (!this.firstTick) {
      this.firstTick = this.tick();
      setInterval(() => {
        this.tick();
      }, POLL_INTERVAL);
    }
    await this.firstTick;
    const byStation = new Map<number, BurnRestriction>();
    for (const [station, county] of this.stationCounties) {
      const restriction = this.counties.get(county);
      if (restriction) byStation.set(station, restriction);
    }
    return byStation;
  }

  private async tick(): Promise<void> {
    try {
      const res = await fetch(BURNSAFE_URL, {
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const counties = parseBurnSafe(await res.text());
      if (counties.size === 0) throw new Error('no county rows on the page');
      this.counties = counties;
    } catch (error) {
      console.error('Failed to fetch BurnSafe restrictions:', error);
    }
  }
}

declare global {
  var __burnSafePoller: BurnSafePoller | undefined;
}

export function getBurnRestrictions(): Promise<Map<number, BurnRestriction>> {
  globalThis.__burnSafePoller ??= new BurnSafePoller();
  return globalThis.__burnSafePoller.byStation();
}
