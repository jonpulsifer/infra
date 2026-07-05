""" Display the weather from WeatherFlow """

load("render.star", "render")
load("http.star", "http")
load("encoding/base64.star", "base64")
load("cache.star", "cache")
load("encoding/json.star", "json")
load("schema.star", "schema")

DEFAULT_STATION_ID = "85191"
DEFAULT_TOKEN = ""
WEATHERFLOW_API_URL = "https://swd.weatherflow.com/swd/rest/better_forecast?station_id=%s&token=%s"

def main(config):
    """ This program is called by the device to render the screen.

    Returns:
        A render.Root object that will be rendered by the device.
    """

    station_id = config.str("station_id", DEFAULT_STATION_ID)
    token = config.str("token", DEFAULT_TOKEN)
    api_url = WEATHERFLOW_API_URL % (station_id, token)

    cache_key = "forecast:%s" % station_id
    forecast_cached = cache.get(cache_key)
    if forecast_cached != None:
        print("Cache hit!")
        forecast = json.decode(forecast_cached)
    else:
        print("Cache miss! Calling WeatherFlow API")
        rep = http.get(api_url)
        if rep.status_code != 200:
            fail("WeatherFlow API request failed with status %d", rep.status_code)
        forecast = rep.json()
        cache.set(cache_key, json.encode(forecast), ttl_seconds = 300)

    # Get the current location name
    location = forecast["location_name"]

    # Get the current weather conditions
    current = forecast["current_conditions"]
    # daily = forecast["forecast"]["daily"]
    # hourly = forecast["forecast"]["hourly"]

    temp = current["air_temperature"]
    feels_like = current["feels_like"]
    conditions = current["conditions"]
    font = "tb-8"
    return render.Root(
        delay = 100,
        child = render.Box(
            padding = 1,
            color = "#00f5",
            child = render.Column(
                main_align = "center",
                children = [
                    render.Marquee(
                        width = 64,
                        child = render.Text(location, font = font),
                    ),
                    render.Text("%d°" % (temp), font = font),
                    render.Text(conditions, font = font),
                    render.Text("Feels like %d°" % feels_like, font = font),
                ],
            ),
        ),
    )

def get_schema():
    return schema.Schema(
        version = "1",
        fields = [
            schema.Text(
                id = "station_id",
                name = "Station ID",
                desc = "WeatherFlow Tempest station ID.",
                icon = "towerBroadcast",
                default = DEFAULT_STATION_ID,
            ),
            schema.Text(
                id = "token",
                name = "Token",
                desc = "WeatherFlow API personal access token.",
                icon = "key",
                default = DEFAULT_TOKEN,
            ),
        ],
    )
