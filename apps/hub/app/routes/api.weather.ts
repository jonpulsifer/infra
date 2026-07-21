import { getWeatherSnapshot } from '~/services/weather.server';

export async function loader() {
  return Response.json(await getWeatherSnapshot(), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
