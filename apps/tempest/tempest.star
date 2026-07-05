""" Display the weather from a WeatherFlow Tempest station.

Three pages rendered in sequence:
  1. Current conditions - animated pixel-art icon, big temperature,
     feels-like, and a stats ticker (conditions, humidity, wind, pressure).
  2. Three day forecast - day, icon, high/low, precip probability bar.
  3. Next 24 hours - temperature plot from the hourly forecast.
"""

load("cache.star", "cache")
load("encoding/json.star", "json")
load("http.star", "http")
load("render.star", "render")
load("schema.star", "schema")
load("time.star", "time")

DEFAULT_STATION_ID = "85191"
DEFAULT_TOKEN = ""
WEATHERFLOW_API_URL = "https://swd.weatherflow.com/swd/rest/better_forecast?station_id=%s&token=%s"
CACHE_TTL_SECONDS = 300

FRAME_MS = 50
ICON_STATES = 8  # distinct animation states per icon
ICON_HOLD = 3  # frames to hold each state
STATIC_PAGE_FRAMES = 70  # ~3.5s per static page

UNIT_PARAMS = {
    "metric": "&units_temp=c&units_wind=kph&units_pressure=mb&units_precip=mm&units_distance=km",
    "imperial": "&units_temp=f&units_wind=mph&units_pressure=inhg&units_precip=in&units_distance=mi",
}

# palette
COLOR_SUN = "#ffb300"
COLOR_SUN_GLOW = "#7a5000"
COLOR_MOON = "#d8d8ea"
COLOR_CLOUD = "#9aa7b0"
COLOR_CLOUD_DARK = "#5b6770"
COLOR_RAIN = "#41a7ff"
COLOR_SNOW = "#eef4ff"
COLOR_BOLT = "#ffe94a"
COLOR_BOLT_DIM = "#b89a00"
COLOR_FOG = "#8a949c"
COLOR_HI = "#ffb050"
COLOR_LO = "#6fb2ff"
COLOR_DIM = "#8a94a6"
COLOR_LABEL = "#9ab8d8"

def main(config):
    """Render the Tempest weather app.

    Returns:
        A render.Root object that will be rendered by the device.
    """
    station_id = config.str("station_id", DEFAULT_STATION_ID)
    token = config.str("token", DEFAULT_TOKEN)
    units = config.str("units", "auto")

    # dev/self-hosted override; not exposed in the schema
    api_url = config.str("api_url", "")
    if api_url == "":
        if token == "":
            return splash("Add a WeatherFlow token in the app settings")
        api_url = WEATHERFLOW_API_URL % (station_id, token)
        api_url += UNIT_PARAMS.get(units, "")

    forecast, err = get_forecast(api_url, "%s:%s" % (station_id, units))
    if err != None:
        return splash(err)

    current = forecast.get("current_conditions", {})
    daily = forecast.get("forecast", {}).get("daily", [])
    hourly = forecast.get("forecast", {}).get("hourly", [])
    unit_labels = forecast.get("units", {})
    tz = forecast.get("timezone", "UTC")

    pages = [page_current(current, unit_labels)]
    if config.bool("show_forecast", True) and len(daily) > 0:
        pages.append(hold(page_forecast(daily, tz)))
    if config.bool("show_graph", True) and len(hourly) > 1:
        pages.append(hold(page_graph(hourly)))

    return render.Root(
        delay = FRAME_MS,
        show_full_animation = True,
        child = render.Sequence(children = pages),
    )

def get_forecast(api_url, cache_suffix):
    """Fetch the forecast, serving from cache when possible.

    Returns:
        (forecast dict, None) on success, (None, error message) on failure.
    """
    cache_key = "forecast:%s" % cache_suffix
    cached = cache.get(cache_key)
    if cached != None:
        print("Cache hit!")
        return json.decode(cached), None

    print("Cache miss! Calling WeatherFlow API")
    rep = http.get(api_url)
    if rep.status_code != 200:
        return None, "WeatherFlow API error %d" % rep.status_code
    forecast = rep.json()
    if forecast.get("current_conditions") == None:
        return None, "No conditions for this station"
    cache.set(cache_key, json.encode(forecast), ttl_seconds = CACHE_TTL_SECONDS)
    return forecast, None

# ---------------------------------------------------------------------------
# pages
# ---------------------------------------------------------------------------

def page_current(current, unit_labels):
    temp = int(current.get("air_temperature", 0))
    feels = int(current.get("feels_like", temp))
    icon_name = current.get("icon", "cloudy")

    icon_frames = []
    for state in range(ICON_STATES):
        for _ in range(ICON_HOLD):
            icon_frames.append(weather_icon(icon_name, 20, state))

    right = render.Column(
        main_align = "center",
        cross_align = "center",
        expanded = True,
        children = [
            render.Text("%d°" % temp, font = "6x13", color = temp_color(temp)),
            render.Text("feels %d°" % feels, font = "tom-thumb", color = COLOR_DIM),
        ],
    )

    top = render.Row(
        expanded = True,
        children = [
            render.Box(width = 22, height = 24, child = render.Animation(children = icon_frames)),
            render.Box(width = 42, height = 24, child = right),
        ],
    )

    ticker = render.Marquee(
        width = 64,
        offset_start = 16,
        child = render.Text(ticker_text(current, unit_labels), font = "tb-8"),
    )

    return render.Column(children = [top, ticker])

def ticker_text(current, unit_labels):
    parts = [current.get("conditions", "")]

    rh = current.get("relative_humidity")
    if rh != None:
        parts.append("%d%% RH" % int(rh))

    wind = current.get("wind_avg")
    if wind != None:
        wind_str = "%s %d" % (current.get("wind_direction_cardinal", ""), int(wind))
        gust = current.get("wind_gust")
        if gust != None and int(gust) > int(wind):
            wind_str += "-%d" % int(gust)
        parts.append("%s %s" % (wind_str, unit_labels.get("units_wind", "")))

    pressure = current.get("sea_level_pressure")
    if pressure != None:
        trend = {"rising": "+", "falling": "-"}.get(current.get("pressure_trend", ""), "")
        parts.append("%d %s%s" % (int(pressure), unit_labels.get("units_pressure", ""), trend))

    uv = current.get("uv")
    if uv != None and int(uv) > 0:
        parts.append("UV %d" % int(uv))

    strikes = current.get("lightning_strike_count_last_1hr")
    if strikes != None and int(strikes) > 0:
        parts.append("%d strikes/hr" % int(strikes))

    return "  |  ".join([p for p in parts if p != ""])

def page_forecast(daily, tz):
    cols = []
    for day in daily[0:3]:
        name = time.from_timestamp(int(day.get("day_start_local", 0))).in_location(tz).format("Mon").upper()
        prob = int(day.get("precip_probability", 0))
        children = [
            render.Text(name, font = "tom-thumb", color = COLOR_LABEL),
            render.Box(width = 1, height = 1),
            weather_icon(day.get("icon", "cloudy"), 10, 0),
            render.Box(width = 1, height = 1),
            render.Text("%d°" % int(day.get("air_temp_high", 0)), font = "tom-thumb", color = COLOR_HI),
            render.Text("%d°" % int(day.get("air_temp_low", 0)), font = "tom-thumb", color = COLOR_LO),
        ]
        if prob >= 20:
            children.append(render.Box(width = max(2, prob * 12 // 100), height = 1, color = COLOR_RAIN))
        cols.append(render.Column(cross_align = "center", children = children))

    return render.Row(
        expanded = True,
        main_align = "space_evenly",
        cross_align = "center",
        children = cols,
    )

def page_graph(hourly):
    hours = hourly[0:24]
    temps = [h.get("air_temperature", 0) for h in hours]
    hi = int(max(temps))
    lo = int(min(temps))

    header = render.Row(
        expanded = True,
        main_align = "space_between",
        children = [
            render.Text("24H", font = "tom-thumb", color = COLOR_LABEL),
            render.Row(children = [
                render.Text("%d°" % hi, font = "tom-thumb", color = COLOR_HI),
                render.Text(" %d°" % lo, font = "tom-thumb", color = COLOR_LO),
            ]),
        ],
    )

    plot = render.Plot(
        data = [(i, temps[i]) for i in range(len(temps))],
        width = 64,
        height = 25,
        color = COLOR_HI,
        color_inverted = COLOR_LO,
        fill = True,
        fill_color = "#552f00",
        fill_color_inverted = "#0a2c55",
    )

    return render.Column(children = [header, plot])

def hold(page):
    """Wrap a static page in an Animation so it stays up for a few seconds."""
    return render.Animation(children = [page for _ in range(STATIC_PAGE_FRAMES)])

def splash(message):
    return render.Root(
        child = render.Column(
            expanded = True,
            main_align = "center",
            cross_align = "center",
            children = [
                render.Row(children = [
                    weather_icon("partly-cloudy-day", 10, 0),
                    render.Box(width = 2, height = 1),
                    render.Text("TEMPEST", font = "tb-8", color = COLOR_LABEL),
                ]),
                render.Marquee(width = 62, child = render.Text(message, font = "tom-thumb", color = COLOR_DIM)),
            ],
        ),
    )

def temp_color(t):
    if t <= -10:
        return "#37a1ff"
    if t < 0:
        return "#7cc4ff"
    if t < 10:
        return "#cfe8ff"
    if t < 20:
        return "#ffffff"
    if t < 27:
        return "#ffd767"
    if t < 33:
        return "#ff9a4d"
    return "#ff5545"

# ---------------------------------------------------------------------------
# pixel-art weather icons
# ---------------------------------------------------------------------------

def at(x, y, widget):
    return render.Padding(pad = (x, y, 0, 0), child = widget)

def weather_icon(name, size, state):
    """Draw a pixel-art icon for a WeatherFlow icon name.

    Args:
        name: WeatherFlow icon id, e.g. "partly-cloudy-day".
        size: icon canvas edge in pixels (tuned for 20 and 10).
        state: animation state in [0, ICON_STATES).

    Returns:
        A size x size widget.
    """
    night = name.endswith("night")
    parts = []

    if name.startswith("clear"):
        parts = moon_parts(size) if night else sun_parts(size, state)
    elif "thunder" in name:
        parts = cloud_parts(size, COLOR_CLOUD_DARK, 0) + bolt_parts(size, state)
    elif "snow" in name:
        parts = cloud_parts(size, COLOR_CLOUD, 0) + snow_parts(size, state)
    elif "sleet" in name:
        parts = cloud_parts(size, COLOR_CLOUD, 0) + sleet_parts(size, state)
    elif "rain" in name:
        parts = cloud_parts(size, COLOR_CLOUD_DARK, 0) + rain_parts(size, state)
    elif name.startswith("partly"):
        peek = moon_parts(size * 3 // 4) if night else sun_parts(size * 3 // 4, state)
        parts = peek + cloud_parts(size, COLOR_CLOUD, size // 5)
    elif name.startswith("fog"):
        parts = fog_parts(size, state)
    elif name.startswith("wind"):
        parts = wind_parts(size, state)
    else:  # cloudy and anything unknown
        parts = cloud_parts(size, COLOR_CLOUD, size // 8)

    return render.Box(
        width = size,
        height = size,
        child = render.Stack(children = parts),
    )

def sun_parts(size, state):
    d = size * 3 // 5
    off = (size - d) // 2
    mid = size // 2
    ray = max(1, size // 10)
    parts = [
        at(off - 1, off - 1, render.Circle(color = COLOR_SUN_GLOW, diameter = d + 2)),
        at(off, off, render.Circle(color = COLOR_SUN, diameter = d)),
    ]
    if state % 2 == 0:
        # cardinal rays
        parts.append(at(mid, 0, render.Box(width = 1, height = ray, color = COLOR_SUN)))
        parts.append(at(mid, size - ray, render.Box(width = 1, height = ray, color = COLOR_SUN)))
        parts.append(at(0, mid, render.Box(width = ray, height = 1, color = COLOR_SUN)))
        parts.append(at(size - ray, mid, render.Box(width = ray, height = 1, color = COLOR_SUN)))
    else:
        # diagonal rays
        c = off - 2 if off >= 2 else 0
        f = size - c - 1
        for (x, y) in [(c, c), (f, c), (c, f), (f, f)]:
            parts.append(at(x, y, render.Box(width = 1, height = 1, color = COLOR_SUN)))
    return parts

def moon_parts(size):
    d = size * 3 // 5
    off = (size - d) // 2
    return [
        at(off, off, render.Circle(color = COLOR_MOON, diameter = d)),
        at(off + d // 3, off - d // 6, render.Circle(color = "#000000", diameter = d * 4 // 5)),
    ]

def cloud_parts(size, color, y_off):
    s = size
    return [
        at(s * 2 // 5, y_off + s // 6, render.Circle(color = color, diameter = s // 2)),
        at(s // 10, y_off + s * 3 // 10, render.Circle(color = color, diameter = s * 2 // 5)),
        at(s // 6, y_off + s * 2 // 5, render.Box(width = s * 7 // 10, height = s // 4, color = color)),
    ]

def rain_parts(size, state):
    return precip_parts(size, state, 2, COLOR_RAIN, 1)

def snow_parts(size, state):
    return precip_parts(size, state // 2, 1, COLOR_SNOW, 1)

def sleet_parts(size, state):
    return precip_parts(size, state, 2, COLOR_RAIN, 2) + precip_parts(size, state // 2, 1, COLOR_SNOW, 2)[1:2]

def precip_parts(size, state, drop_h, color, col_step):
    top = size * 7 // 10
    span = size - top - 1
    if span < 2:
        span = 2
    parts = []
    cols = [size // 5, size // 2, size * 4 // 5]
    for i in range(0, len(cols), col_step):
        y = top + (state + i * 2) % span
        h = min(drop_h, size - y)
        parts.append(at(cols[i], y, render.Box(width = 1, height = h, color = color)))
    return parts

BOLT_PIXELS = [(2, 0), (1, 1), (0, 2), (1, 2), (2, 2), (2, 3), (1, 4)]

def bolt_parts(size, state):
    color = COLOR_BOLT if state % 4 < 2 else COLOR_BOLT_DIM
    scale = 1 if size < 16 else 2
    x0 = size * 2 // 5
    y0 = size // 2
    return [
        at(x0 + x * scale, y0 + y * scale * 3 // 4, render.Box(width = scale, height = scale, color = color))
        for (x, y) in BOLT_PIXELS
        if y0 + y * scale * 3 // 4 + scale <= size
    ]

def fog_parts(size, state):
    parts = []
    w = size * 3 // 4
    for i in range(3):
        x = (i * 2 + state // 2) % (size - w)
        y = size * 2 // 5 + i * size // 5
        parts.append(at(x, y, render.Box(width = w, height = 1, color = COLOR_FOG)))
    return parts

def wind_parts(size, state):
    parts = []
    lengths = [size * 3 // 4, size // 2, size * 3 // 5]
    for i in range(3):
        y = size * 3 // 10 + i * size // 5
        x = (state + i * 2) % max(1, size - lengths[i])
        parts.append(at(x, y, render.Box(width = lengths[i], height = 1, color = "#c8d2da")))
    return parts

# ---------------------------------------------------------------------------
# schema
# ---------------------------------------------------------------------------

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
            schema.Dropdown(
                id = "units",
                name = "Units",
                desc = "Units of measurement.",
                icon = "rulerHorizontal",
                default = "auto",
                options = [
                    schema.Option(display = "Station default", value = "auto"),
                    schema.Option(display = "Metric", value = "metric"),
                    schema.Option(display = "Imperial", value = "imperial"),
                ],
            ),
            schema.Toggle(
                id = "show_forecast",
                name = "3-day forecast",
                desc = "Show the three day forecast page.",
                icon = "calendarDays",
                default = True,
            ),
            schema.Toggle(
                id = "show_graph",
                name = "24h graph",
                desc = "Show the next-24-hours temperature graph.",
                icon = "chartLine",
                default = True,
            ),
        ],
    )
