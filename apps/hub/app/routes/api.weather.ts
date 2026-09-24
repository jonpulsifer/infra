import { getBurnRestrictions } from '~/services/burnsafe.server';
import { getWeatherSnapshot } from '~/services/weather.server';

export async function loader() {
  const [snapshot, burn] = await Promise.all([
    getWeatherSnapshot(),
    getBurnRestrictions(),
  ]);
  const stations = snapshot.stations.map((station) => {
    const restriction = burn.get(station.stationId);
    return restriction ? { ...station, burn: restriction } : station;
  });
  return Response.json(
    { ...snapshot, stations },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
