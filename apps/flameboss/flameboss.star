"""Live Flame Boss barbecue cooks from the flameboss exporter's /api/cook.

Pages: the pit over a pixel fire, the meat probes, the cook chart and alerts.
"""

load("cache.star", "cache")
load("encoding/json.star", "json")
load("filter.star", "filter")
load("http.star", "http")
load("math.star", "math")
load("render.star", "canvas", "render")
load("schema.star", "schema")

DEFAULT_API_URL = "http://flameboss.monitoring:8080/api/cook"
DEFAULT_DONE_F = 203
DEFAULT_WRAP_F = 165
CACHE_TTL_SECONDS = 15

# The lab's alert thresholds and `for` windows, from
# clusters/folly/monitoring/flameboss-rules.yaml.
AT_SET_F = 5
LOW_BY_F = 25
HIGH_BY_F = 30
STARVING_BY_F = 15
STARVING_BLOWER_PCT = 99
RECENT_ALARM_SECONDS = 900
PIT_LOW_SECONDS = 600
PIT_HIGH_SECONDS = 600
STARVING_SECONDS = 900
PIT_PROBE_SECONDS = 300

# A stall holds over the hour and its newer half, so a probe climbing out is
# not stalled. ETAs wait for the wrap point, where the climb to pull is near linear.
STALL_FLOOR_F = 140
STALL_MIN_FPH = -1
STALL_RATE_FPH = 4
STALL_WINDOW_SECONDS = 3600
ETA_WINDOW_SECONDS = 2700
ETA_MIN_RATE_FPH = 3
ETA_MAX_SECONDS = 8 * 3600
RATE_WINDOW_SECONDS = 1800
WRAP_FRESH_SECONDS = 1800
BAR_FLOOR_F = 40  # fridge-cold meat: where the probe bars start

FRAME_MS = 100  # divided by scale on 2x, while frame counts double
SPLASH_FRAME_MS = 50
BUDGET_FRAMES = 148  # inside the 15s Tronbyt dwell
ALERT_FRAMES = 40
CALM_FRAMES = 50
MIN_CALM_FRAMES = 30
MAX_ALERT_PAGES = 2
FIRE_LOOP = 24  # frames before the fire repeats without a jump, so pages can cut anywhere
BLINK_FRAMES = 4
GROW_FRAMES = 8
REVEAL_FRAMES = 10
BREATH_FRAMES = 16
FAN_STEP_DEGREES = 10
IDLE_FRAMES = 40

# PULL IT is set a letter at a time so each letter can shine: steps that keep
# the terminus capitals apart and inside the border.
PULL_STEP = {1: 8, 2: 14}

FONTS = {
    1: {"hero": "terminus-18", "big": "terminus-14", "mid": "terminus-12", "small": "tom-thumb", "fan": "tom-thumb"},
    2: {"hero": "terminus-32", "big": "terminus-28", "mid": "terminus-18", "small": "terminus-12", "fan": "terminus-14"},
}

# Per font: (advance of a capital, blank rows above a capital, capital height).
# Readings that must fit are measured with render.Text().size() instead.
METRICS = {
    "tom-thumb": (4, 0, 5),
    "terminus-12": (6, 2, 8),
    "terminus-14": (9, 2, 10),
    "terminus-18": (10, 3, 12),
    "terminus-28": (13, 5, 17),
    "terminus-32": (16, 6, 20),
}

COLOR_HERO = "#ffbe3a"
COLOR_HERO_GLOW = "#ff4800"
COLOR_HOT = "#ff5a3a"
COLOR_HOT_GLOW = "#c00000"
COLOR_TEXT = "#fff1dc"
COLOR_LABEL = "#d08a4a"
COLOR_GOOD = "#9be15d"
COLOR_WARN = "#ffb000"
COLOR_BAD = "#ff3424"
COLOR_GOLD = "#ffd23f"
COLOR_STALE = "#9a9a9a"
COLOR_STALE_GLOW = "#3c3c3c"
COLOR_TRACK = "#5a2810"
COLOR_PIT = "#ff7a1a"
COLOR_SET = "#7d8ea0"
COLOR_PULL_LINE = "#b08a20"
COLOR_WRAP_LINE = "#8a8a8a"
COLOR_SCAN = "#b04a10"
COLOR_TICK = "#4e5a6a"
COLOR_BLACK = "#000000"
COLOR_WHITE = "#ffffff"
PROBE_COLORS = ["#ff5c8a", "#4cc3ff", "#b48aff"]

# Flame layers, outermost first: (color, share of each tongue's size). 2x
# has the room for a white-hot heart as well.
FLAME_LAYERS = [
    ("#a01000", 1.0),
    ("#ff3c00", 0.76),
    ("#ff9400", 0.52),
    ("#ffd84a", 0.3),
]
FLAME_HEART = ("#fff6d0", 0.15)
GHOST_LAYERS = [
    ("#2c2c2c", 1.0),
    ("#3e3e3e", 0.76),
    ("#545454", 0.52),
    ("#6c6c6c", 0.3),
]
TONGUE_STEPS = 6
LOW_FIRE = 0.4  # a starving fire's flame height, as a share of a full one
COALS = ["#7a1000", "#b01c00", "#e03400", "#ff6a00", "#ffae1a"]
COAL_GAP = "#4a0800"
ASH = ["#3a3a3a", "#4c4c4c", "#5e5e5e"]
SMOKE = ["#c8c8c8", "#a8a8a8", "#888888", "#5c5c5c"]
SMOKE_WISPS = 4
SMOKE_PUFFS = 12
EMBERS = ["#fff2a8", "#ffc21a", "#ff7a00", "#e03000", "#901400"]
FAN_COLORS = {"b": "#ffe6c0", "c": "#ff7a00", "h": "#8a8a8a"}
FAN_STALE = {"b": "#9a9a9a", "c": "#6a6a6a", "h": "#5a5a5a"}

def main(config):
    """Render the Flame Boss display.

    Returns:
        A render.Root, or [] when there is no cook and show_idle is off so
        Tronbyt skips the app in rotation.
    """
    scale = 2 if canvas.is2x() else 1
    snap, err = get_snapshot(config.str("api_url", DEFAULT_API_URL))
    if err != None:
        return splash(err, scale)
    state = display_state(snap, config)

    ctx = {
        "scale": scale,
        "fonts": FONTS[scale],
        "units": "C" if config.str("units", "F") == "C" else "F",
        "fans": {},
    }
    st = state["cook"]
    if st == None:
        if not config.bool("show_idle", False):
            return []
        return render.Root(
            delay = FRAME_MS // scale,
            show_full_animation = True,
            child = page_idle(state, ctx),
        )

    ctx["live"] = st["active"]
    ctx["fire"] = fire_frames(st, ctx)

    pages = []
    budget = BUDGET_FRAMES
    for kind in st["alerts"]:
        pages.append(page_alert(kind, st, ctx, ALERT_FRAMES * scale))
        budget -= ALERT_FRAMES

    calm = [page_fire]
    if len(st["probes"]) > 0:
        calm.append(page_meat)
    if st["chart"] != None:
        calm.append(page_chart)
    per = min(CALM_FRAMES, budget // len(calm))
    if per < MIN_CALM_FRAMES and len(calm) > 2:
        calm = calm[0:2]
        per = min(CALM_FRAMES, budget // len(calm))
    for page in calm:
        pages.append(page(st, ctx, per * scale))

    return render.Root(
        delay = FRAME_MS // scale,
        show_full_animation = True,
        child = render.Sequence(children = pages),
    )

def get_snapshot(api_url):
    """Fetch the exporter snapshot, serving from cache when possible.

    Returns:
        (snapshot dict, None) on success, (None, error message) on failure.
    """
    cache_key = "flameboss:%s" % api_url
    cached = cache.get(cache_key)
    if cached != None:
        return json.decode(cached), None

    rep = http.get(api_url)
    if rep.status_code != 200:
        return None, "Flame Boss API error %d" % rep.status_code
    snap = json.decode(rep.body(), default = None)
    if snap == None:
        return None, "Flame Boss API returned no JSON"
    if type(snap) != "dict" or type(snap.get("devices")) != "list":
        return None, "Flame Boss API returned no devices"
    cache.set(cache_key, json.encode(snap), ttl_seconds = CACHE_TTL_SECONDS)
    return snap, None

def display_state(snap, config):
    """Resolve a raw snapshot into everything the pages need to render.

    A configured device the exporter has not seen reads as one with no cook.

    Returns:
        A dict with the chosen device (None when there are none), whether the
        cloud link is up, and the device's resolved cook (None when it has none).
    """
    devices = [d for d in snap["devices"] if type(d) == "dict"]
    wanted = config.str("device", "").strip()
    if wanted != "":
        chosen = [d for d in devices if id_text(d.get("id")) == wanted] + [{"id": wanted}]
    else:
        cooks = [d for d in devices if type(d.get("cook")) == "dict"]
        chosen = [d for d in cooks if d["cook"].get("active") != False] + cooks + devices

    device = chosen[0] if len(chosen) > 0 else None
    state = {
        "cloud": snap.get("cloud_connected") != False,
        "device": device,
        "cook": None,
    }
    if device == None or type(device.get("cook")) != "dict":
        return state

    done_f = parse_fahrenheit(config.str("done_f", ""), DEFAULT_DONE_F)
    wrap_f = min(parse_fahrenheit(config.str("wrap_f", ""), DEFAULT_WRAP_F), done_f)
    state["cook"] = cook_state(device, device["cook"], state["cloud"], done_f, wrap_f)
    return state

def cook_state(device, cook, cloud, done_f, wrap_f):
    """Resolve one cook against the lab's thresholds, in Fahrenheit.

    Returns:
        A dict of the cook's readings and flags, its probes, the chart limits
        (None when there is nothing to draw) and its alert pages.
    """
    hist = cook.get("history") if type(cook.get("history")) == "dict" else {}
    step = num(hist.get("step_seconds"))
    if step == None or step <= 0:
        step = 60.0
    probe_hist = hist.get("probes_f") if type(hist.get("probes_f")) == "list" else []
    raw_probes = cook.get("probes") if type(cook.get("probes")) == "list" else []
    pit_hist = series(hist.get("pit_f"))
    set_hist = series(hist.get("set_f"))

    pit = num(cook.get("pit_f"))
    set_f = num(cook.get("set_f"))
    active = cook.get("active") != False
    reached = cook.get("reached_set") == True
    blower = clamp(num(cook.get("blower_pct")) or 0.0, 0.0, 100.0)
    delta = pit - set_f if pit != None and set_f != None else None
    elapsed = num(cook.get("elapsed_seconds"))
    now = elapsed if elapsed != None else (len(pit_hist) - 1) * step
    under = [t - p if p != None and t != None else None for p, t in zip(pit_hist, set_hist)]

    probes = []
    for i in range(len(PROBE_COLORS)):
        raw = raw_probes[i] if i < len(raw_probes) and type(raw_probes[i]) == "dict" else {}
        values = series(probe_hist[i]) if i < len(probe_hist) else []
        probe = probe_state(raw, i, values, step, active, done_f, wrap_f)
        if probe["temp"] != None:
            probes.append(probe)

    pit_low = delta != None and reached and delta < -LOW_BY_F
    pit_high = delta != None and delta > HIGH_BY_F
    starving = delta != None and reached and delta < -STARVING_BY_F and blower >= STARVING_BLOWER_PCT
    st = {
        "pit": pit,
        "set": set_f,
        "delta": delta,
        "at_set": delta != None and abs(delta) <= AT_SET_F,
        "heating": delta != None and not reached and delta < -AT_SET_F,
        "pit_low": pit_low,
        "pit_high": pit_high,
        "starving": starving,
        # The same conditions held over each rule's `for` window: these call alerts.
        "held": {
            "pit_low": pit_low and sustained([d != None and d > LOW_BY_F for d in under], step, now, PIT_LOW_SECONDS),
            "pit_high": pit_high and sustained([d != None and d < -HIGH_BY_F for d in under], step, now, PIT_HIGH_SECONDS),
            "starving": starving and sustained([d != None and d > STARVING_BY_F for d in under], step, now, STARVING_SECONDS),
            "pit_probe": pit == None and sustained([p == None for p in pit_hist], step, now, PIT_PROBE_SECONDS),
        },
        "pit_alarm": recent(cook.get("pit_alarm_seconds_ago")),
        "vent": recent(cook.get("vent_advice_seconds_ago")),
        "lid_open": cook.get("lid_open") == True,
        "blower": blower,
        "duty": blower / 100,
        "active": active,
        "offline": device.get("online") == False,
        "cloud": cloud,
        "quiet": num(cook.get("quiet_seconds")) or 0.0,
        "elapsed": num(cook.get("elapsed_seconds")) or 0.0,
        "probes": probes,
        "done": [p for p in probes if p["stage"] == "done"],
        "done_f": done_f,
        "wrap_f": wrap_f,
        "step": step,
        "pit_hist": pit_hist,
        "set_hist": set_hist,
    }
    st["chart"] = chart_limits(st)
    st["alerts"] = alerts_for(st)
    return st

def probe_state(raw, index, values, step, active, done_f, wrap_f):
    """Resolve one meat probe and call its stage from its history.

    Returns:
        A dict with the probe's label, colour, temperature and history, and a
        stage of done, wrap, stall, eta, rate or none. "rate" (F per hour) and
        "eta" (seconds) are None unless the history supports them.
    """
    temp = num(raw.get("temp_f"))
    label = raw.get("label") if type(raw.get("label")) == "string" else ""
    probe = {
        "number": index + 1,
        "label": printable(label),
        "color": PROBE_COLORS[index],
        "temp": temp,
        "history": values,
        "alarm": raw.get("alarm_triggered") == True,
        "stage": "none",
        "rate": None,
        "eta": None,
    }
    if temp == None:
        return probe
    if probe["alarm"] or temp >= done_f:
        probe["stage"] = "done"
        return probe
    if not active:
        return probe

    hour = trend(values, step, STALL_WINDOW_SECONDS)
    climb = trend(values, step, ETA_WINDOW_SECONDS)
    lately = trend(values, step, RATE_WINDOW_SECONDS)
    eta = None
    if temp >= wrap_f and climb != None and climb["steady"] and climb["rate"] >= ETA_MIN_RATE_FPH:
        eta = (done_f - temp) / climb["rate"] * 3600

    rose = first_rise(values, wrap_f)
    if temp >= wrap_f and rose != None and (len(values) - 1 - rose) * step <= WRAP_FRESH_SECONDS:
        probe["stage"] = "wrap"
    elif hour != None and temp >= STALL_FLOOR_F and stalled(hour["rate"]) and stalled(hour["late"]):
        probe["stage"] = "stall"
        probe["rate"] = hour["rate"]
    elif eta != None and eta <= ETA_MAX_SECONDS:
        probe["stage"] = "eta"
        probe["eta"] = eta
    elif lately != None:
        probe["stage"] = "rate"
        probe["rate"] = lately["rate"]
    return probe

def trend(values, step, window):
    """Fit a line to the tail of a history series.

    Returns:
        {"rate", "late": F per hour over the window and over its newer half,
        "steady": both halves climb at rates within 2x of each other}, or None
        when the tail is too sparse, too short, or does not reach the present.
    """
    n = len(values)
    span = int(window // step) + 1
    points = [(i * step, values[i]) for i in range(max(0, n - span), n) if values[i] != None]
    if len(points) < 4:
        return None
    if points[-1][0] < (n - 2) * step or points[-1][0] - points[0][0] < window * 2 // 3:
        return None
    half = len(points) // 2
    early = slope(points[0:half + 1]) * 3600
    late = slope(points[half:]) * 3600
    return {
        "rate": slope(points) * 3600,
        "late": late,
        "steady": early > 0 and late > 0 and late / early >= 0.5 and late / early <= 2,
    }

def slope(points):
    """Least-squares slope of [(t, v)] in units of v per t."""
    n = len(points)
    mean_t = 0.0
    mean_v = 0.0
    for t, v in points:
        mean_t += t / n
        mean_v += v / n
    num_ = 0.0
    den = 0.0
    for t, v in points:
        num_ += (t - mean_t) * (v - mean_v)
        den += (t - mean_t) * (t - mean_t)
    return num_ / den if den > 0 else 0.0

def stalled(fph):
    return fph > STALL_MIN_FPH and fph < STALL_RATE_FPH

def first_rise(values, threshold):
    """The index of the first bucket where a series rose through threshold, or None."""
    below = False
    for i, v in enumerate(values):
        if v != None and v < threshold:
            below = True
        elif v != None and below:
            return i
    return None

def sustained(flags, step, now, window):
    """Whether every history bucket covering the last window seconds, and the
    one before it, is flagged. A history shorter than that holds nothing."""
    start = int((now - window) // step) - 1
    if start < 0:
        return False
    return all(flags[start:])

def alerts_for(st):
    """List the alert pages, most urgent first, keeping a slot for PULL IT.

    A quiet cook's lid and pit are history, so it shows only why it went quiet.
    An open lid explains a low pit.
    """
    alerts = []
    if not st["cloud"]:
        alerts.append("cloud")
    elif not st["active"]:
        alerts.append("silent")
    if st["active"]:
        if st["lid_open"]:
            alerts.append("lid")
        if st["held"]["pit_probe"]:
            alerts.append("pit_probe")
        if st["pit_alarm"]:
            alerts.append("pit_alarm")
        elif st["held"]["starving"]:
            alerts.append("starving")
        elif st["held"]["pit_high"]:
            alerts.append("pit_high")
        elif st["held"]["pit_low"] and not st["lid_open"]:
            alerts.append("pit_low")
        elif st["vent"]:
            alerts.append("vent")
    if len(st["done"]) > 0:
        return alerts[0:MAX_ALERT_PAGES - 1] + ["pull"]
    return alerts[0:MAX_ALERT_PAGES]

def chart_limits(st):
    """Size the cook chart so every series and the probe targets fit.

    Returns:
        None unless the pit or a probe has two readings, else the bucket
        count and shared y limits.
    """
    lines = [st["pit_hist"]] + [p["history"] for p in st["probes"]]
    length = max([len(v) for v in lines + [st["set_hist"]]])
    readable = [v for v in lines if len([x for x in v if x != None]) > 1]
    if length < 2 or len(readable) == 0:
        return None
    values = [x for v in lines + [st["set_hist"]] for x in v if x != None]
    if len(st["probes"]) > 0:
        values += [st["wrap_f"], st["done_f"]]
    lo = min(values)
    hi = max(values)
    pad = max(5.0, (hi - lo) * 0.06)
    return {"length": length, "y_lim": (lo - pad, hi + pad)}

def parse_fahrenheit(text, fallback):
    """Read a Fahrenheit setting such as "203", "203F" or "203.5", falling
    back on anything else or anything outside a cooking range."""
    s = text.strip().upper().replace("°", "").rstrip("F").strip()
    if s.count(".") > 1 or not s.replace(".", "").isdigit():
        return float(fallback)
    value = float(s)
    return value if value >= 50 and value <= 600 else float(fallback)

def num(value):
    """The value as a float, or None when it is not a JSON number."""
    return float(value) if type(value) in ("int", "float") else None

def series(value):
    """Coerce a history array into floats and Nones."""
    if type(value) != "list":
        return []
    return [num(v) for v in value]

def recent(seconds_ago):
    seconds = num(seconds_ago)
    return seconds != None and seconds >= 0 and seconds < RECENT_ALARM_SECONDS

def id_text(value):
    if type(value) in ("int", "float"):
        return "%d" % int(value)
    return value.strip() if type(value) == "string" else ""

def printable(text):
    """Text in capitals, kept to the printable ASCII and Latin-1 the fonts
    draw, with its spaces collapsed."""
    out = []
    for c in text.upper().codepoints():
        code = ord(c)
        if (code > 32 and code < 127) or (code > 160 and code < 256):
            out.append(c)
        elif c.isspace() or code == 160:
            out.append(" ")
    return " ".join("".join(out).split())

def clamp(value, lo, hi):
    return max(lo, min(hi, value))

# Words.

def shown(temp_f, ctx):
    """A Fahrenheit reading as the display shows it: rounded, in its units."""
    return int(math.round(temp_f if ctx["units"] == "F" else (temp_f - 32) * 5 / 9))

def deg(temp_f, ctx):
    """A temperature with its degree sign, or -- when there is no reading."""
    if temp_f == None:
        return "--"
    return "%d°" % shown(temp_f, ctx)

def fit_reading(temp_f, ctx, fonts, room):
    """A reading in the first of fonts that fits room pixels, with its degree
    sign and then without. Returns (text, font)."""
    text = deg(temp_f, ctx)
    bare = text.replace("°", "")
    for font in fonts:
        for t in (text, bare):
            if render.Text(t, font = font).size()[0] - 1 <= room:
                return t, font
    return bare, fonts[-1]

def pit_off(st, ctx):
    """The pit's distance from set as the difference of the two readings as
    displayed, so it always agrees with the numbers beside it."""
    return shown(st["pit"], ctx) - shown(st["set"], ctx)

def rate_text(fph, ctx):
    value = int(math.round(fph if ctx["units"] == "F" else fph * 5 / 9))
    return ("+%d°/h" if value >= 0 else "%d°/h") % value

def duration(seconds):
    """Compact elapsed time: 45m, 5h12."""
    return hours_minutes(int(seconds) // 60)

def hours_minutes(minutes):
    if minutes < 60:
        return "%dm" % minutes
    return "%dh%s" % (minutes // 60, ("0%d" % (minutes % 60))[-2:])

def eta_text(seconds):
    """An ETA to the nearest five minutes: 2h55, or 45m."""
    return hours_minutes(max(5, int(math.round(seconds / 300)) * 5))

def short_name(p, chars):
    """Fit a probe's label into chars, keeping the cut (the last word) of a
    long label: PORK BUTT is BUTT. An unnamed probe is PROBE 2, or P2 where
    that does not fit."""
    name = p["label"]
    if name == "":
        name = "PROBE %d" % p["number"]
        return name if len(name) <= chars else "P%d" % p["number"]
    if len(list(name.codepoints())) <= chars:
        return name
    return "".join(list(name.split(" ")[-1].codepoints())[0:chars])

def text_width(text, font):
    """Width of text in pixels, including the gap after its last glyph."""
    return len(list(text.codepoints())) * METRICS[font][0]

def fits(text, font, room):
    return text_width(text, font) - 1 <= room

# Drawing.

def at(x, y, child):
    return render.Padding(pad = (x, y, 0, 0), child = child)

def label_at(x, y, text, font, color):
    """Place text so its capitals start at row y, whatever the font's line box."""
    return at(x, y - METRICS[font][1], render.Text(text, font = font, color = color))

def right_text(x_end, y, text, font, color):
    return label_at(x_end - text_width(text, font), y, text, font, color)

def centre_x(x_mid, width):
    """The left edge that centres width pixels on x_mid, kept inside the display."""
    return clamp(x_mid - width // 2, 1, canvas.width() - width)

def centre_text(x_mid, y, text, font, color):
    return label_at(centre_x(x_mid, text_width(text, font)), y, text, font, color)

def glow_text(text, font, color, glow, ctx):
    """Text over a blurred copy of itself. filter.Blur grows its bounds by
    three radii on each side, so the halo is pulled back by that much."""
    radius = ctx["scale"]
    pull = -3 * radius
    return render.Stack(children = [
        render.Padding(
            pad = (pull, pull, 0, 0),
            child = filter.Blur(radius = float(radius), child = render.Text(text, font = font, color = glow)),
        ),
        render.Text(text, font = font, color = color),
    ])

def glow_at(x, y, text, font, color, glow, ctx):
    return at(x, y - METRICS[font][1], glow_text(text, font, color, glow, ctx))

def outlined(x, y, text, font, color):
    """Text ringed in black, so it stays legible where flames lick up behind it."""
    shadow = [
        label_at(x + dx, y + dy, text, font, COLOR_BLACK)
        for dx, dy in [(-1, 0), (1, 0), (0, -1), (0, 1)]
    ]
    return render.Stack(children = shadow + [label_at(x, y, text, font, color)])

def canvas_box():
    return render.Box(width = canvas.width(), height = canvas.height())

def mix(a, b, amount):
    """Mix #rrggbb a toward b by amount in [0, 1]."""
    ca = [int(a[i:i + 2], 16) for i in (1, 3, 5)]
    cb = [int(b[i:i + 2], 16) for i in (1, 3, 5)]
    return "#" + "".join([("0%x" % int(ca[i] + (cb[i] - ca[i]) * amount))[-2:] for i in range(3)])

def breath(frame, scale):
    """A slow 0..1..0 ease for calm pulses."""
    return 0.5 - 0.5 * math.cos(frame * 2 * math.pi / (BREATH_FRAMES * scale))

def ease_out(t):
    u = 1 - t
    return 1 - u * u * u

def hsh(n):
    """A deterministic pseudo-random value in [0, 1) for a seed."""
    v = math.sin(n * 12.9898 + 78.233) * 43758.5453
    return v - math.floor(v)

def sprite(art, palette, px):
    """Draw pixel art from rows of palette keys; "." is transparent. Each
    run of one colour in a row is one box."""
    rows = []
    for line in art:
        runs = []
        start = 0
        for j in range(1, len(line) + 1):
            if j == len(line) or line[j] != line[start]:
                key = line[start]
                width = (j - start) * px
                if key == ".":
                    runs.append(render.Box(width = width, height = px))
                else:
                    runs.append(render.Box(width = width, height = px, color = palette[key]))
                start = j
        rows.append(render.Row(children = runs))
    return render.Column(children = rows)

# The fire.

def fire_frames(st, ctx):
    """The fire scene, one widget per frame of FIRE_LOOP. It burns low while
    the fire starves, and a quiet cook freezes into a grey ghost over ash."""
    s = ctx["scale"]
    loop = FIRE_LOOP * s
    if not st["active"]:
        return [render.Stack(children = [canvas_box()] + flames(0, loop, st["duty"], False, ctx, GHOST_LAYERS) + [coal_bed(0, loop, False, ctx)])]
    low = st["held"]["starving"]
    layers = FLAME_LAYERS + ([FLAME_HEART] if s == 2 else [])
    return [
        render.Stack(children = [canvas_box()] + smoke(f, loop, ctx) + flames(f, loop, st["duty"], low, ctx, layers) + [coal_bed(f, loop, True, ctx)] + embers(f, loop, 0.0 if low else st["duty"], ctx))
        for f in range(loop)
    ]

def fire_height(ctx):
    return 16 * ctx["scale"]

def coal_height(ctx):
    return 3 * ctx["scale"] - 1

def flames(f, loop, duty, low, ctx, layers):
    """Flame tongues in nested colour layers over a burning body, as tall as
    the blower duty, or short and sparse when low. Heights lick on integer
    harmonics of the loop, so the fire repeats without a jump."""
    s = ctx["scale"]
    w = canvas.width()
    base = canvas.height() - coal_height(ctx) + s
    t = 2 * math.pi * f / loop
    reach = (fire_height(ctx) - coal_height(ctx)) * (LOW_FIRE if low else 0.6 + 0.4 * duty)
    count = 11 if s == 1 else 15
    spacing = w / (count - 1)
    shapes = []
    for i in range(count + 1):
        if low and i % 2 == 1:
            continue
        seed = hsh(i + 1)
        lick = 0.7 + 0.18 * math.sin((2 + int(3 * seed)) * t + 9 * seed) + 0.12 * math.sin((5 + int(3 * hsh(i + 9))) * t + 2 * seed)
        shapes.append({
            "x": (i - 0.5 + 0.6 * seed) * spacing,
            "height": reach * lick * (0.65 + 0.35 * hsh(i + 30)),
            "width": spacing * (1.2 + 0.5 * hsh(i + 60)),
            "lean": (hsh(i + 80) - 0.5) * 3 * s,
            "phase": (1 + int(2 * hsh(i + 70))) * t + 6 * seed,
        })
    parts = []
    for color, share in layers:
        body = int(2 * s * share)
        parts.append(at(0, base - body, render.Box(width = w, height = canvas.height() - base + body, color = color)))
        for shape in shapes:
            parts.append(tongue(shape, share, base, s, color))
    return parts

def tongue(shape, share, base, s, color):
    """One flame tongue: widest a quarter of the way up, narrowing to a tip,
    its spine bent by a wave that travels upward as the phase advances."""
    left = []
    right = []
    width = shape["width"] * share
    height = shape["height"] * share
    for j in range(TONGUE_STEPS + 1):
        v = j / TONGUE_STEPS
        half = width / 2 * math.pow(1 - v, 0.9) * (1 + 1.2 * v)
        x = shape["x"] + shape["lean"] * share * math.pow(v, 1.5) + 1.6 * s * share * v * math.sin(7.5 * v - shape["phase"])
        y = base - height * v
        left.append((x - half, y))
        right.insert(0, (x + half, y))
    verts = left + right[1:]
    x0 = math.floor(min([p[0] for p in verts]))
    y0 = math.floor(min([p[1] for p in verts]))
    return at(int(x0), int(y0), render.Polygon(
        vertices = [(p[0] - x0, p[1] - y0) for p in verts],
        fill_color = color,
    ))

def coal_bed(f, loop, live, ctx):
    """A row of charcoal lumps that breathe between colours, split by dark
    gaps, or grey ash when the cook has gone cold."""
    s = ctx["scale"]
    w = canvas.width()
    t = 2 * math.pi * f / loop
    height = coal_height(ctx)
    lumps = []
    x = 0
    for i in range(w):
        if x >= w:
            break
        width = min((3 + int(3 * hsh(i + 700))) * s, w - x)
        seed = hsh(i + 900)
        if live:
            glow = 0.5 + 0.5 * math.sin((1 + int(2 * seed)) * t + 6.28 * seed)
            level = min(len(COALS) - 1, int(glow * len(COALS)))
            crest, base = COALS[level], COALS[max(0, level - 2)]
        else:
            crest = ASH[int(seed * len(ASH))]
            base = ASH[0]
        lumps.append(render.Column(children = [
            render.Box(width = width - 1, height = s, color = crest),
            render.Box(width = width - 1, height = height - s, color = base),
        ]))
        lumps.append(render.Box(width = 1, height = height, color = COAL_GAP if live else COLOR_BLACK))
        x += width
    return at(0, canvas.height() - height, render.Row(children = lumps))

def smoke(f, loop, ctx):
    """Wisps of smoke that curl up off the flames and thin out, softened by a
    blur. 2x only: 1x has no clear air above its fire to put them in."""
    if ctx["scale"] == 1:
        return []
    w = canvas.width()
    floor_y = canvas.height() - fire_height(ctx) // 2
    puffs = []
    for k in range(SMOKE_WISPS):
        x0 = (k + 0.5) * w / SMOKE_WISPS + 8 * (hsh(k + 600) - 0.5)
        for j in range(SMOKE_PUFFS):
            p = (f / loop + j / SMOKE_PUFFS + 0.37 * k) % 1.0
            x = int(x0 + 7 * p * math.sin(2 * math.pi * (p + 0.29 * k)) + 5 * p)
            y = int(floor_y - p * 30)
            size = 2 + int(3 * p)
            puffs.append(at(x, y, render.Box(width = size, height = size, color = SMOKE[min(len(SMOKE) - 1, int(p * len(SMOKE)))])))
    return [render.Padding(
        pad = (-3, -3, 0, 0),
        child = filter.Blur(radius = 1.0, child = render.Stack(children = [canvas_box()] + puffs)),
    )]

def embers(f, loop, duty, ctx):
    """Sparks that leave the flames, drift, cool and wink out once per loop."""
    s = ctx["scale"]
    w = canvas.width()
    floor_y = canvas.height() - coal_height(ctx) - 2 * s
    out = []
    for k in range(int((1 + 6 * duty) * s)):
        seed = hsh(k + 300)
        p = ((f + seed * loop) % loop) / loop
        rise = floor_y * (0.3 + 0.35 * hsh(k + 400))
        y = int(floor_y - p * rise)
        x = int(seed * (w - s) + 2 * s * math.sin(2 * math.pi * (p * 1.5 + seed)))
        color = EMBERS[min(len(EMBERS) - 1, int(p * len(EMBERS)))]
        size = s if p > 0.35 or s == 1 else 2
        if x >= 0 and x < w and y >= 0:
            out.append(at(x, y, render.Box(width = size, height = size, color = color)))
    return out

def fan(angle, ctx):
    """The blower fan at a rotation angle in degrees, cached in ctx per step.
    It has three blades, since a four-spoke pinwheel reads as a symbol."""
    s = ctx["scale"]
    blades = 3
    symmetry = 360 // blades
    key = int(angle // FAN_STEP_DEGREES) % (symmetry // FAN_STEP_DEGREES)
    if key in ctx["fans"]:
        return ctx["fans"][key]
    size = 9 if s == 1 else 15
    c = (size - 1) // 2
    theta = math.radians(key * FAN_STEP_DEGREES)
    grid = [["." for _ in range(size)] for _ in range(size)]
    if s == 1:
        for k in range(blades):
            a = theta + 2 * math.pi * k / blades
            for r, lag in [(1.0, 0), (2.0, 0), (3.0, 0), (3.6, 0.45), (3.4, -0.3)]:
                grid[c + int(math.round(r * math.sin(a + lag)))][c + int(math.round(r * math.cos(a + lag)))] = "b"
    else:
        ring = c + 0.45
        for y in range(size):
            for x in range(size):
                r = math.sqrt((x - c) * (x - c) + (y - c) * (y - c))
                if r > ring:
                    continue
                if r > ring - 1:
                    grid[y][x] = "h"
                    continue
                a = (math.atan2(y - c, x - c) - theta - 0.5 * r / ring) % (2 * math.pi / blades)
                if min(a, 2 * math.pi / blades - a) < 0.42:
                    grid[y][x] = "b"
    grid[c][c] = "c"
    widget = sprite(["".join(row) for row in grid], FAN_COLORS if ctx["live"] else FAN_STALE, 1)
    ctx["fans"][key] = widget
    return widget

# Calm pages.

def pit_status(st, ctx):
    """Seven characters or fewer on the pit against set, and their colour: the
    signed difference, or why there is none."""
    if not st["active"]:
        ago = duration(st["quiet"])
        return ("%s AGO" % ago if len(ago) <= 3 else ago, COLOR_STALE)
    if st["pit"] == None:
        return ("NO PIT", COLOR_BAD)
    if st["lid_open"]:
        return ("LID UP", COLOR_BAD)
    if st["delta"] == None:
        return ("NO SET", COLOR_WARN)
    if st["heating"]:
        return ("HEATING", COLOR_WARN)
    off = pit_off(st, ctx)
    color = COLOR_WARN
    if st["at_set"]:
        color = COLOR_GOOD
    elif st["pit_high"] or st["pit_low"] or st["starving"]:
        color = COLOR_BAD
    if off == 0:
        return ("±0°", color)
    return (("+%d°" if off > 0 else "%d°") % off, color)

def hero_colors(st):
    """The pit temperature's colour and glow: ember gold, red when the pit is
    in trouble, grey when the reading is history."""
    if not st["active"]:
        return (COLOR_STALE, COLOR_STALE_GLOW)
    if st["pit"] == None or st["pit_high"] or st["pit_low"] or st["starving"] or st["pit_alarm"]:
        return (COLOR_HOT, COLOR_HOT_GLOW)
    return (COLOR_HERO, COLOR_HERO_GLOW)

def page_fire(st, ctx, frames):
    """The hero: pit temperature glowing over the live fire, the blower fan
    spinning at its duty, and the set temperature with a status word."""
    s = ctx["scale"]
    fonts = ctx["fonts"]
    small = fonts["small"]
    w = canvas.width()
    live = st["active"]
    text_color = COLOR_TEXT if live else COLOR_STALE
    hero_color, glow = hero_colors(st)
    status, status_color = pit_status(st, ctx)

    fan_size = 9 if s == 1 else 15
    fan_x = w - fan_size - 2 * (s - 1)
    blower = "%d%%" % int(math.round(st["blower"]))
    blower_end = fan_x - 3 * (s - 1)
    blower_x = blower_end - text_width(blower, fonts["fan"])
    pit, pit_font = fit_reading(st["pit"], ctx, [fonts["hero"], fonts["big"]], blower_x - s - (s - 1))
    line_y = 15 if s == 1 else 29
    set_label = "SET "
    set_x = s + text_width(set_label, small)
    status_x = w - s - text_width(status, small)
    set_text, _ = fit_reading(st["set"], ctx, [small], status_x - 1 - set_x)
    statics = [
        glow_at(s - 1, s, pit, pit_font, hero_color, glow, ctx),
        right_text(blower_end, s + (fan_size - METRICS[fonts["fan"]][2]) // 2, blower, fonts["fan"], text_color),
        outlined(s, line_y, set_label, small, COLOR_LABEL),
        outlined(set_x, line_y, set_text, small, text_color),
        outlined(status_x, line_y, status, small, status_color),
    ]
    spin = st["duty"] * 36 if live else 0
    loop = ctx["fire"]
    return render.Animation(children = [
        render.Stack(children = [loop[f % len(loop)]] + statics + [at(fan_x, s, fan(f * spin / s, ctx))])
        for f in range(frames)
    ])

def page_meat(st, ctx, frames):
    """Each plugged probe's temperature, a bar from fridge-cold to pull with
    the wrap point marked, and its call. The bars grow in, then the tips pulse."""
    s = ctx["scale"]
    probes = st["probes"]
    grow = GROW_FRAMES * s if st["active"] else 0

    def build(fill, lit):
        parts = [canvas_box()]
        if len(probes) == 1:
            parts.extend(meat_solo(probes[0], st, ctx, fill, lit))
        else:
            row = meat_pair if len(probes) == 2 else meat_trio
            row_h = canvas.height() // len(probes)
            for i, p in enumerate(probes):
                parts.extend(row(p, i * row_h, st, ctx, fill, lit))
        return render.Stack(children = parts)

    held = [build(1.0, True), build(1.0, False)]
    return render.Animation(children = [
        build(ease_out((f + 1) / grow), True) if f < grow else held[((f - grow) // (BLINK_FRAMES * s)) % 2]
        for f in range(frames)
    ])

def probe_call(p, ctx):
    """The probe's call: (short words, long words, colour, blinks)."""
    stage = p["stage"]
    if stage == "done":
        return ("PULL", "PULL NOW", COLOR_GOLD, False)
    if stage == "wrap":
        return ("WRAP", "WRAP IT", COLOR_WARN, True)
    if stage == "stall":
        return ("STALL", "STALL %s" % rate_text(p["rate"], ctx), COLOR_WARN, False)
    if stage == "eta":
        return ("IN %s" % eta_text(p["eta"]), "PULL IN %s" % eta_text(p["eta"]), COLOR_TEXT, False)
    if stage == "rate":
        rate = rate_text(p["rate"], ctx)
        return (rate, rate, COLOR_LABEL, False)
    return ("", "", COLOR_TEXT, False)

def call_words(call, font, room):
    """The long form of a call where it fits in room pixels, else the short."""
    return call[1] if fits(call[1], font, room) else call[0]

def call_text(x_end, y, words, call, font, lit):
    """A call right-aligned on x_end, hidden on the off beat if it blinks."""
    return right_text(x_end, y, words if lit or not call[3] else "", font, call[2])

def meat_temp_colors(p, st):
    if not st["active"]:
        return (COLOR_STALE, COLOR_STALE_GLOW)
    return (COLOR_TEXT, p["color"])

def bar_x(value, st, width):
    span = st["done_f"] - BAR_FLOOR_F
    return int(math.round(clamp((value - BAR_FLOOR_F) / span, 0.0, 1.0) * width))

def meat_bar(p, width, height, st, fill, lit):
    """A thermometer bar from BAR_FLOOR_F to the pull temperature, with the
    wrap point ticked. fill in [0, 1] grows it in; a done probe flashes gold."""
    filled = int(math.round(bar_x(p["temp"], st, width) * fill))
    wrap_x = min(bar_x(st["wrap_f"], st, width), width - 1)
    parts = [render.Box(width = width, height = height, color = COLOR_TRACK)]
    if p["stage"] == "done":
        parts.append(render.Box(width = max(1, filled), height = height, color = COLOR_GOLD if lit else COLOR_WARN))
        return render.Stack(children = parts)
    parts.append(at(width - 1, 0, render.Box(width = 1, height = height, color = COLOR_GOLD)))
    if not st["active"]:
        if filled > 0:
            parts.append(render.Box(width = filled, height = height, color = COLOR_STALE))
        return render.Stack(children = parts)
    bands = [(0, "#c01800"), (width // 2, "#ff4a00"), (wrap_x, "#ff9a00"), (width, None)]
    for j in range(len(bands) - 1):
        x0 = bands[j][0]
        x1 = min(bands[j + 1][0], filled)
        if x1 > x0:
            parts.append(at(x0, 0, render.Box(width = x1 - x0, height = height, color = bands[j][1])))
    if wrap_x >= filled:
        parts.append(at(wrap_x, 0, render.Box(width = 1, height = height, color = COLOR_WHITE)))
    if filled > 0:
        parts.append(at(filled - 1, 0, render.Box(width = 1, height = height, color = "#fff2b0" if lit else "#ffb030")))
    return render.Stack(children = parts)

def meat_solo(p, st, ctx, fill, lit):
    """One probe fills the page: its name and call, its temperature, the pull
    temperature, and a bar with the wrap point labelled."""
    s = ctx["scale"]
    fonts = ctx["fonts"]
    small = fonts["small"]
    adv = METRICS[small][0]
    w = canvas.width()
    call = probe_call(p, ctx)
    words = call_words(call, small, w - 2 * s - text_width(short_name(p, 10) + " ", small))
    bar_y = 22 * s
    bar_h = 4 * s
    bar_w = w - 2 * s
    name_room = (w - 2 * s - text_width(words, small)) // adv - (1 if words != "" else 0)
    color, glow = meat_temp_colors(p, st)
    wrap = deg(st["wrap_f"], ctx) if s == 1 else "WRAP " + deg(st["wrap_f"], ctx)
    done = deg(st["done_f"], ctx)
    column = w - s - max(text_width("DONE", small), text_width(done, small))
    temp, temp_font = fit_reading(p["temp"], ctx, [fonts["hero"], fonts["big"]], column - 1 - s)
    return [
        label_at(s, s, short_name(p, name_room), small, p["color"]),
        call_text(w - s, s, words, call, small, lit),
        glow_at(s, 8 * s, temp, temp_font, color, glow, ctx),
        right_text(w - s, 9 * s, "DONE", small, COLOR_LABEL),
        right_text(w - s, 15 * s, done, small, COLOR_GOLD),
        at(s, bar_y, meat_bar(p, bar_w, bar_h, st, fill, lit)),
        centre_text(s + bar_x(st["wrap_f"], st, bar_w), bar_y + bar_h + s, wrap, small, COLOR_LABEL),
    ]

def meat_pair(p, y, st, ctx, fill, lit):
    """Half the page per probe: the temperature, then the name, bar and call
    stacked beside it."""
    s = ctx["scale"]
    fonts = ctx["fonts"]
    small = fonts["small"]
    w = canvas.width()
    x = 35 if s == 1 else 60
    room = w - x - s
    color, glow = meat_temp_colors(p, st)
    call = probe_call(p, ctx)
    words = call_words(call, small, room)
    temp, temp_font = fit_reading(p["temp"], ctx, [fonts["big"], fonts["mid"]], x - 1 - s)
    return [
        glow_at(s, y + 3 * s, temp, temp_font, color, glow, ctx),
        label_at(x, y + s, short_name(p, (room + 1) // METRICS[small][0]), small, p["color"]),
        at(x, y + 7 * s, meat_bar(p, room, 3 * s, st, fill, lit)),
        call_text(x + text_width(words, small), y + 11 * s, words, call, small, lit),
    ]

def meat_trio(p, y, st, ctx, fill, lit):
    """A third of the page per probe: the temperature, then the name and call
    over the bar. 2x words every call in its long form where all of them fit."""
    s = ctx["scale"]
    fonts = ctx["fonts"]
    small = fonts["small"]
    adv = METRICS[small][0]
    w = canvas.width()
    x = 20 if s == 1 else 46
    temp, temp_font = fit_reading(p["temp"], ctx, [fonts["mid"], small], x - 1 - s)
    color, glow = meat_temp_colors(p, st)
    call = probe_call(p, ctx)
    room = w - x - s
    words = call[0]
    name_chars = (room + 1 - (text_width(words, small) + adv if words != "" else 0)) // adv
    if s == 2 and all([fits("%s %s" % (short_name(q, 6), probe_call(q, ctx)[1]), small, room) for q in st["probes"]]):
        words = call[1]
        name_chars = 6
    reading = label_at(s, y + s, temp.replace("°", ""), temp_font, color)
    if s == 2:
        reading = glow_at(s, y + 4, temp, temp_font, color, glow, ctx)
    return [
        reading,
        label_at(x, y + s + (s - 1), short_name(p, name_chars), small, p["color"]),
        call_text(w - s, y + s + (s - 1), words, call, small, lit),
        at(x, y + 7 * s - (s - 1), meat_bar(p, room, 2 * s, st, fill, lit)),
    ]

def page_chart(st, ctx, frames):
    """The cook so far: the pit over its set line and each probe climbing
    toward the dotted pull line on shared axes, drawn in by a scan line. At 2x
    a gutter labels set, pull and wrap, and the bottom edge ticks each hour."""
    s = ctx["scale"]
    w = canvas.width()
    head = 7 * s
    chart = st["chart"]
    x_lim = (0, chart["length"] - 1)
    y_lim = chart["y_lim"]
    probes = st["probes"]

    guides = []
    if len(probes) > 0:
        guides.append((st["done_f"], COLOR_PULL_LINE, COLOR_GOLD))
        if s == 2:
            guides.append((st["wrap_f"], COLOR_WRAP_LINE, COLOR_TEXT))
    marks = []
    if s == 2:
        set_now = last_value(st["set_hist"])
        if set_now == None:
            set_now = st["set"]
        marks = [(v, label) for v, _, label in guides]
        if set_now != None:
            marks = marks[0:1] + [(set_now, COLOR_SET)] + marks[1:]
    gutter = 0
    if s == 2:
        gutter = max([14] + [text_width(axis_text(v, ctx), "tom-thumb") + 2 for v, _ in marks])
    plot_w = w - gutter
    plot_h = canvas.height() - head
    layers = [render.Box(width = plot_w, height = plot_h)]
    for value, color, _ in guides:
        layers.append(dotted(value, color, plot_w, plot_h, y_lim, s))
    if s == 2:
        layers.extend(hour_ticks(st, chart, plot_w, plot_h))
    layers.extend(plots(st["set_hist"], COLOR_SET, plot_w, plot_h, x_lim, y_lim))
    for p in probes:
        layers.extend(plots(p["history"], p["color"], plot_w, plot_h, x_lim, y_lim))
    layers.extend(plots(st["pit_hist"], COLOR_PIT, plot_w, plot_h, x_lim, y_lim))
    plot = render.Stack(children = layers)

    newest = [(p["history"], p["color"]) for p in probes] + [(st["pit_hist"], COLOR_PIT)]
    ends = [end_point(v, color, plot_w, plot_h, x_lim, y_lim, s) for v, color in newest]
    ends = [e for e in ends if e != None]

    axis = None
    if s == 2:
        axis = render.Stack(children = [render.Box(width = gutter, height = plot_h)] + axis_labels(marks, gutter, plot_h, y_lim, ctx))

    reveal = REVEAL_FRAMES * s if st["active"] else 0
    out = []
    for f in range(frames):
        if f < reveal:
            cut = plot_w * (f + 1) // reveal
            body = [plot]
            if cut < plot_w:
                body.append(at(cut, 0, render.Box(width = plot_w - cut, height = plot_h, color = COLOR_BLACK)))
                body.append(at(cut, 0, render.Box(width = s, height = plot_h, color = COLOR_SCAN)))
        else:
            glow = breath(f - reveal, s) if st["active"] else 0.0
            body = [plot] + [e(glow) for e in ends]
        frame = render.Stack(children = body)
        out.append(render.Row(children = [axis, frame]) if axis != None else frame)
    return render.Column(children = [chart_header(st, ctx), render.Animation(children = out)])

def chart_header(st, ctx):
    """COOK and the elapsed time, and the probes named in their line colours
    where the names fit, dropping COOK to make room."""
    s = ctx["scale"]
    small = ctx["fonts"]["small"]
    adv = METRICS[small][0]
    w = canvas.width()
    elapsed = duration(st["elapsed"])
    room = w - 2 * s - adv
    names = legend(st["probes"], [9], small, room - text_width("COOK " + elapsed, small))
    title = [("COOK ", COLOR_LABEL), (elapsed, COLOR_TEXT)]
    if names == None:
        names = legend(st["probes"], [9, 8, 7, 6, 5], small, room - text_width(elapsed, small))
        if names != None:
            title = [(elapsed, COLOR_TEXT)]
    parts = [render.Box(width = w, height = 7 * s)]
    x = s
    for text, color in title:
        parts.append(label_at(x, s, text, small, color))
        x += text_width(text, small)
    x = w - s
    for name, color in reversed(names or []):
        x -= text_width(name, small)
        parts.append(label_at(x, s, name, small, color))
        x -= adv
    return render.Stack(children = parts)

def legend(probes, lengths, font, room):
    """The probes' names at the longest of lengths that fits room pixels.

    Returns:
        [(name, color)], or None when there are no probes or nothing fits.
    """
    if len(probes) == 0:
        return None
    for chars in lengths:
        names = [(short_name(p, chars), p["color"]) for p in probes]
        if text_width(" ".join([n for n, _ in names]), font) <= room:
            return names
    return None

def axis_labels(marks, width, height, y_lim, ctx):
    """Right-aligned labels for the 2x gutter, skipping any that would overlap
    one already placed."""
    placed = []
    out = []
    for value, color in marks:
        _, y = to_px(0, value, width, height, (0, 1), y_lim)
        top = clamp(y - 2, 0, height - 5)
        if len([p for p in placed if abs(p - top) < 6]) > 0:
            continue
        placed.append(top)
        out.append(right_text(width - 2, top, axis_text(value, ctx), "tom-thumb", color))
    return out

def axis_text(value, ctx):
    return deg(value, ctx).replace("°", "")

def hour_ticks(st, chart, width, height):
    """A short tick on the bottom edge at every elapsed hour."""
    out = []
    for h in range(1, int(chart["length"] * st["step"] // 3600) + 1):
        x, _ = to_px(h * 3600 / st["step"], 0, width, height, (0, chart["length"] - 1), (0, 1))
        if x < width - 1:
            out.append(at(x, height - 3, render.Box(width = 1, height = 3, color = COLOR_TICK)))
    return out

def last_value(values):
    for v in reversed(values):
        if v != None:
            return v
    return None

def plots(values, color, width, height, x_lim, y_lim):
    """One render.Plot per unbroken run of a series; nulls split the line."""
    out = []
    run = []
    for i, v in enumerate(values + [None]):
        if v != None:
            run.append((i, v))
        elif len(run) > 0:
            out.append(render.Plot(
                data = run if len(run) > 1 else run + run,
                width = width,
                height = height,
                color = color,
                x_lim = x_lim,
                y_lim = y_lim,
            ))
            run = []
    return out

def to_px(i, v, width, height, x_lim, y_lim):
    x = int(math.round((i - x_lim[0]) / max(1, x_lim[1] - x_lim[0]) * (width - 1)))
    y = int(math.round((1 - (v - y_lim[0]) / (y_lim[1] - y_lim[0])) * (height - 1)))
    return x, y

def end_point(values, color, width, height, x_lim, y_lim, scale):
    """The newest reading of a series as a dot that breathes toward white.

    Returns:
        A function of glow in [0, 1] returning the dot, or None for an empty
        series.
    """
    last = [i for i, v in enumerate(values) if v != None]
    if len(last) == 0:
        return None
    x, y = to_px(last[-1], values[last[-1]], width, height, x_lim, y_lim)
    size = 2 * scale

    def draw(glow):
        return at(clamp(x - size // 2, 0, width - size), clamp(y - size // 2, 0, height - size), render.Box(width = size, height = size, color = mix(color, COLOR_WHITE, glow)))

    return draw

def dotted(value, color, width, height, y_lim, scale):
    """A dotted horizontal guide at a probe target (pull, wrap)."""
    _, y = to_px(0, value, width, height, (0, 1), y_lim)
    dots = [at(x, y, render.Box(width = scale, height = scale, color = color)) for x in range(0, width, 3 * scale)]
    return render.Stack(children = [render.Box(width = width, height = height)] + dots)

# Alerts.

def page_alert(kind, st, ctx, frames):
    """A page in a border of chasing lights: an animated icon, two big words
    and detail lines shown in turn."""
    if kind == "pull":
        return page_pull(st, ctx, frames)
    spec = alert_spec(kind, st, ctx)
    s = ctx["scale"]
    fonts = ctx["fonts"]
    w = canvas.width()
    title_font = fonts["big"]
    line_gap = METRICS[title_font][2] + 2 * s
    widest = max([text_width(line, title_font) for line in spec["title"]])
    title_x = min(21 * s + 2 * (s - 1), w - widest)
    titles = [
        label_at(title_x, 2 * s + i * line_gap, line, title_font, COLOR_TEXT)
        for i, line in enumerate(spec["title"])
    ]
    details = [centre_text(w // 2, 25 * s, d, fonts["small"], spec["color"]) for d in spec["detail"]]
    borders = [chase_border(k, spec["color"], ctx) for k in range(4)]
    return render.Animation(children = [
        render.Stack(children = [borders[(f // s) % 4]] + titles + [
            details[(f * len(details)) // frames],
            at(2 * s, 2 * s, spec["icon"](f, ctx)),
        ])
        for f in range(frames)
    ])

def alert_spec(kind, st, ctx):
    """Title lines, detail lines of 15 characters or fewer, the border colour
    and the icon for an alert."""
    pit = deg(st["pit"], ctx)
    against = "%s SET %s" % (pit, deg(st["set"], ctx))
    quiet = "QUIET %s" % duration(st["quiet"])
    if kind == "cloud":
        return {"title": ["CLOUD", "DOWN"], "detail": ["NO MQTT LINK", quiet], "color": COLOR_BAD, "icon": icon_cloud}
    if kind == "silent":
        return {"title": ["GONE", "QUIET"], "detail": [quiet, "OFFLINE" if st["offline"] else "NO READINGS"], "color": COLOR_BAD, "icon": icon_quiet}
    if kind == "lid":
        return {"title": ["LID", "OPEN"], "detail": ["PIT " + pit], "color": COLOR_BAD, "icon": icon_lid}
    if kind == "pit_probe":
        return {"title": ["PIT", "PROBE"], "detail": ["UNPLUGGED", "NO CONTROL"], "color": COLOR_BAD, "icon": icon_plug}
    if kind == "pit_alarm":
        return {"title": ["PIT", "ALARM"], "detail": [against] + (["CLOSE VENT"] if st["vent"] else []), "color": COLOR_BAD, "icon": icon_bell}
    if kind == "vent":
        return {"title": ["CLOSE", "VENT"], "detail": [against], "color": COLOR_WARN, "icon": icon_vent}
    off = pit_off(st, ctx)
    if kind == "starving":
        detail = ["FAN %d%%" % int(math.round(st["blower"])), "%d° UNDER SET" % -off]
        return {"title": ["ADD", "FUEL"], "detail": detail, "color": COLOR_BAD, "icon": icon_fuel}
    if kind == "pit_high":
        return {"title": ["PIT", "HIGH"], "detail": ["%d° OVER SET" % off], "color": COLOR_BAD, "icon": icon_hot}
    return {"title": ["PIT", "LOW"], "detail": ["%d° UNDER SET" % -off], "color": COLOR_BAD, "icon": icon_cold}

def chase_border(k, color, ctx):
    """Marquee lights round the canvas, two lit and two dark, stepped by k:
    cycling k through four steps makes the lights chase."""
    s = ctx["scale"]
    w = canvas.width()
    h = canvas.height()
    dim = {COLOR_BAD: "#4a0a00", COLOR_WARN: "#4a3000", COLOR_GOLD: "#4a3800"}[color]
    perimeter = [(x, 0) for x in range(0, w, s)]
    perimeter.extend([(w - s, y) for y in range(s, h, s)])
    perimeter.extend([(x, h - s) for x in range(w - 2 * s, -s, -s)])
    perimeter.extend([(0, y) for y in range(h - 2 * s, 0, -s)])
    parts = [canvas_box()]
    for i, (x, y) in enumerate(perimeter):
        lit = ((i + k) // 2) % 2 == 0
        parts.append(at(x, y, render.Box(width = s, height = s, color = color if lit else dim)))
    return render.Stack(children = parts)

def page_pull(st, ctx, frames):
    """PULL IT drops in and shimmers inside gold chasing lights, naming the
    first probe at the pull temperature. Sparkles show only where no text is."""
    s = ctx["scale"]
    fonts = ctx["fonts"]
    small = fonts["small"]
    w = canvas.width()
    p = st["done"][0]
    more = len(st["done"]) - 1
    title = "PULL IT!" if s == 2 else "PULL IT"
    title_font = fonts["big"]
    adv = PULL_STEP[s]
    title_x = (w - adv * len(title)) // 2
    title_y = (6 if more == 0 else 3) * s
    temp = deg(p["temp"], ctx)
    room = (w - 4 * s) // METRICS[fonts["mid"]][0] - len(list(temp.codepoints())) - 1
    lines = [(19 if more == 0 else 16) * s, "%s %s" % (short_name(p, room), temp), fonts["mid"], p["color"]]
    rows = [lines]
    if more > 0:
        rows.append([25 * s, "+%d MORE" % more, small, COLOR_TEXT])
    elif s == 2:
        reason = "PULL AT " + deg(st["done_f"], ctx) if p["temp"] >= st["done_f"] else "PROBE ALARM"
        rows.append([52, reason, small, COLOR_LABEL])

    statics = [centre_text(w // 2, y, text, font, color) for y, text, font, color in rows]
    avoid = [text_box(title_x, title_y, adv * (len(title) - 1) + METRICS[title_font][0], title_font)]
    avoid.extend([text_box(centre_x(w // 2, text_width(text, font)), y, text_width(text, font), font) for y, text, font, _ in rows])
    borders = [chase_border(k, COLOR_GOLD, ctx) for k in range(4)]
    drops = [-14, -8, -3, 1, 0]
    out = []
    for f in range(frames):
        beat = f // s
        drop = drops[beat] * s if beat < len(drops) else 0
        letters = []
        for i, ch in enumerate(title.elems()):
            shine = (beat - 2 * i) % 16 in (0, 1)
            letters.append(label_at(title_x + i * adv, title_y + drop, ch, title_font, COLOR_WHITE if shine else COLOR_GOLD))
        out.append(render.Stack(children = [borders[beat % 4]] + sparkles(f, ctx, avoid) + statics + letters))
    return render.Animation(children = out)

def text_box(x, y, width, font):
    """The half-open box (x0, y0, x1, y1) round text width pixels wide with its
    capitals at row y: accents above, and a row each side and below."""
    return (x - 1, y - 1 - METRICS[font][1], x + width, y + METRICS[font][2] + 1)

def sparkles(f, ctx, avoid):
    """Twinkling stars, each in a new place every time it comes round: a point,
    a cross, then a point. A star whose cross, padded by the scale, would touch
    a box in avoid sits that turn out."""
    s = ctx["scale"]
    w = canvas.width()
    h = canvas.height()
    period = 10 * s
    colors = [COLOR_GOLD, COLOR_WHITE, "#ff5c8a", "#ff9a00"]
    out = []
    for k in range(10 * s):
        age = f + int(hsh(k + 500) * period)
        stage = (age % period) * 4 // period
        cycle = age // period
        arm = s * (2 if stage == 1 else 0)
        x = 4 * s + int(hsh(k * 31 + cycle * 7 + 1) * (w - 9 * s))
        y = 4 * s + int(hsh(k * 17 + cycle * 13 + 2) * (h - 9 * s))
        pad = 3 * s
        reach = (x - pad, y - pad, x + s + pad, y + s + pad)
        hit = [b for b in avoid if reach[0] < b[2] and reach[2] > b[0] and reach[1] < b[3] and reach[3] > b[1]]
        if stage == 3 or len(hit) > 0:
            continue
        color = colors[k % len(colors)]
        out.append(at(x, y - arm, render.Box(width = s, height = 2 * arm + s, color = color)))
        if arm > 0:
            out.append(at(x - arm, y, render.Box(width = 2 * arm + s, height = s, color = color)))
    return out

# Alert icons, drawn on a 1x pixel grid and bevelled on 2x.

ICON_PALETTE = {
    "w": "#fff1dc",
    "g": "#b4b4b4",
    "d": "#7a7a7a",
    "r": "#ff3424",
    "o": "#ff9a00",
    "y": "#ffd23f",
    "b": "#4cc3ff",
}

ICON_BEVEL = {
    "w": "#ffffff",
    "g": "#f0f0f0",
    "d": "#b8b8b8",
    "r": "#ff9a8a",
    "o": "#ffd080",
    "y": "#fff2a0",
    "b": "#b0e6ff",
}

CLOUD_ART = [
    "......wwww......",
    "....wwwwwwww....",
    "...wwwwwwwwww...",
    ".wwwwwwwwwwwwww.",
    "wwwwwwwwwwwwwwww",
    "wwwwwwwwwwwwwwww",
    ".wwwwwwwwwwwwww.",
]

BOLT_ART = ["..rr", ".rr.", "rrrr", ".rr.", "rr.."]

BELL_ART = [
    ".....yy.....",
    "....yyyy....",
    "...yyyyyy...",
    "..yyyyyyyy..",
    "..yyyyyyyy..",
    "..yyyyyyyy..",
    "..yyyyyyyy..",
    ".yyyyyyyyyy.",
    "yyyyyyyyyyyy",
    ".....yy.....",
]

DOME_ART = [
    "....gggggggg....",
    "..gggggggggggg..",
    ".gwwgggggggggggg",
    "gwgggggggggggggg",
    "gggggggggggggggg",
]

BOWL_ART = [
    "gggggggggggggggg",
    ".gwgggggggggggg.",
    "..gggggggggggg..",
    "...gggggggggg...",
    ".....gggggg.....",
    "......d..d......",
    ".....d....d.....",
    "....d......d....",
]

THERMO_ART = [
    "..www..",
    "..w.w..",
    "..w.w..",
    "..wrw..",
    "..wrw..",
    "..wrw..",
    "..wrw..",
    ".wrrrw.",
    ".wrrrw.",
    "..www..",
]

PLUG_ART = [
    ".wwww...",
    ".wwwwgg.",
    ".wwww...",
    "dwwww...",
    ".wwww...",
    ".wwwwgg.",
    ".wwww...",
]

SOCKET_ART = [
    "wwwww.",
    ".wwww.",
    "wwwww.",
    "wwwwwd",
    "wwwww.",
    ".wwww.",
    "wwwww.",
]

# "h" marks the vent's holes, which open and close.
VENT_ART = [
    "....gggg....",
    "..gggggggg..",
    ".gghgggghgg.",
    ".ghhgggghhg.",
    "gggggggggggg",
    "ggggghhggggg",
    "ggggghhggggg",
    "gggggggggggg",
    ".ghhgggghhg.",
    ".gghgggghgg.",
    "..gggggggg..",
    "....gggg....",
]

COAL_ART = [
    "...ggg...ggg....",
    "..gdddg.gdddg...",
    ".gddddggddddgg..",
    "gddddgddddgdddg.",
    "gdddgdddddgddddg",
    ".gggggggggggggg.",
]

EMBER_ART = [
    [".....", "..r..", ".ror."],
    ["..r..", ".ror.", ".ror."],
]

PLUS_ART = ["..y..", "..y..", "yyyyy", "..y..", "..y.."]

FLAME_ART = [
    "..r..",
    ".rr..",
    ".ror.",
    "rooor",
    "royor",
    ".ryr.",
]

CROSS_ART = [
    "rr...rr",
    ".rr.rr.",
    "..rrr..",
    ".rr.rr.",
    "rr...rr",
]

def icon_art(art, s):
    """Draw icon art at the display scale. 2x draws it over a lighter copy one
    pixel up and left, a one-pixel bevel on its top and left edges."""
    if s == 1:
        return sprite(art, ICON_PALETTE, 1)
    return render.Stack(children = [
        sprite(art, ICON_BEVEL, s),
        at(1, 1, sprite(art, ICON_PALETTE, s)),
    ])

def icon_cloud(f, ctx):
    """A cloud with a bolt that flickers out."""
    s = ctx["scale"]
    parts = [at(0, 2 * s, icon_art(CLOUD_ART, s))]
    if (f // (3 * s)) % 3 != 2:
        parts.append(at(6 * s, 10 * s, icon_art(BOLT_ART, s)))
    return render.Stack(children = parts)

def icon_bell(f, ctx):
    """A bell swinging and ringing."""
    s = ctx["scale"]
    swing = [0, 1, 0, -1][(f // (2 * s)) % 4] * s
    parts = [at(2 * s + swing, 2 * s, icon_art(BELL_ART, s))]
    if swing != 0:
        parts.append(at(0 if swing < 0 else 14 * s, 5 * s, icon_art(["y", ".", "y", ".", "y"], s)))
    parts.append(at(7 * s - swing, 13 * s, icon_art(["yy"], s)))
    return render.Stack(children = parts)

def icon_lid(f, ctx):
    """A kettle with its dome lifted off the glowing bowl and smoke pouring
    out of the gap and up past the lid."""
    s = ctx["scale"]
    lift = [0, 1, 1, 2, 2, 2, 1, 1][(f // (2 * s)) % 8] * s
    rim = "#ffd040" if (f // (2 * s)) % 2 == 0 else "#ff7a00"
    parts = [
        at(0, 13 * s, icon_art(BOWL_ART, s)),
        at(0, 12 * s, render.Box(width = 16 * s, height = s, color = rim)),
        at(0, 3 * s - lift, icon_art(DOME_ART, s)),
    ]
    for k in range(4):
        p = ((f // s + k * 5) % 20) / 20.0
        side = 0 if k % 2 == 0 else 14 * s
        x = side + int((1 if k % 2 == 0 else -1) * p * 2 * s + s * math.sin(6 * p + k))
        y = int((10 - p * 10) * s)
        color = "#e0e0e0" if p < 0.4 else ("#a0a0a0" if p < 0.75 else "#606060")
        parts.append(at(max(0, x), max(0, y), render.Box(width = 2 * s, height = 2 * s, color = color)))
    return render.Stack(children = parts)

def icon_hot(f, ctx):
    return thermo_icon(f, ctx, -1)

def icon_cold(f, ctx):
    return thermo_icon(f, ctx, 1)

def thermo_icon(f, ctx, direction):
    """A thermometer with an arrow bobbing up for a hot pit or down for a cold one."""
    s = ctx["scale"]
    step = ((f // (2 * s)) % 4) * direction * s
    arrow = ["..r..", ".rrr.", "r.r.r", "..r..", "..r.."] if direction < 0 else ["..b..", "..b..", "b.b.b", ".bbb.", "..b.."]
    return render.Stack(children = [
        at(2 * s, 4 * s, icon_art(THERMO_ART, s)),
        at(10 * s, 7 * s + step, icon_art(arrow, s)),
    ])

def icon_plug(f, ctx):
    """A probe plug pulled out of its socket, sparking across the gap."""
    s = ctx["scale"]
    gap = [1, 2, 2, 1][(f // (3 * s)) % 4] * s
    parts = [
        at(0, 7 * s, icon_art(PLUG_ART, s)),
        at(8 * s + gap, 7 * s, icon_art(SOCKET_ART, s)),
    ]
    if (f // s) % 6 < 3:
        parts.append(at(7 * s + gap // 2, 9 * s, icon_art([".y.", "yoy", ".y."], s)))
    return render.Stack(children = parts)

def icon_vent(f, ctx):
    """The daisy-wheel vent, its holes opening and closing."""
    s = ctx["scale"]
    hole = "." if (f // (4 * s)) % 2 == 0 else "d"
    return at(3 * s, 5 * s, icon_art([row.replace("h", hole) for row in VENT_ART], s))

def icon_fuel(f, ctx):
    """A spent bed of charcoal with one ember guttering on it, and a plus
    sign blinking for more fuel."""
    s = ctx["scale"]
    parts = [
        at(0, 12 * s, icon_art(COAL_ART, s)),
        at(5 * s, 9 * s, icon_art(EMBER_ART[(f // (2 * s)) % 2], s)),
    ]
    if (f // (4 * s)) % 2 == 0:
        parts.append(at(11 * s, 1 * s, icon_art(PLUS_ART, s)))
    return render.Stack(children = parts)

def icon_quiet(f, ctx):
    """Signal bars that keep trying to light, under a blinking red cross."""
    s = ctx["scale"]
    trying = (f // (3 * s)) % 5
    parts = []
    for i in range(4):
        height = (4 + 3 * i) * s
        parts.append(at(i * 4 * s, 19 * s - height, render.Box(
            width = 3 * s,
            height = height,
            color = ICON_PALETTE["w"] if i < trying else ICON_PALETTE["d"],
        )))
    if (f // (4 * s)) % 2 == 0:
        parts.append(at(0, 2 * s, icon_art(CROSS_ART, s)))
    return render.Stack(children = parts)

# Idle and errors.

def page_idle(state, ctx):
    """A controller with no cook: the kettle cold with its lid down, snoozing
    while the controller and the cloud link are up."""
    s = ctx["scale"]
    fonts = ctx["fonts"]
    device = state["device"]
    ident = id_text(device.get("id")) if device != None else ""
    sub_color = COLOR_LABEL
    if device == None:
        title, sub = "NONE", "NO DEVICES"
    elif not state["cloud"]:
        title, sub, sub_color = "IDLE", "CLOUD DOWN", COLOR_WARN
    elif device.get("online") == False:
        title, sub = "OFF", "OFFLINE"
    else:
        title, sub = "IDLE", "NO COOK"
    snoozing = sub == "NO COOK"
    statics = [
        canvas_box(),
        at(2 * s, 9 * s, icon_art(DOME_ART, s)),
        at(2 * s, 14 * s, render.Box(width = 16 * s, height = s, color = ICON_PALETTE["d"])),
        at(2 * s, 15 * s, icon_art(BOWL_ART, s)),
        label_at(22 * s, 6 * s, title, fonts["big"], COLOR_HERO if snoozing else COLOR_STALE),
        label_at(22 * s, 19 * s, sub, fonts["small"], sub_color),
        label_at(22 * s, 26 * s, ident, fonts["small"], COLOR_STALE),
    ]
    frames = []
    for f in range(IDLE_FRAMES * s):
        parts = list(statics)
        for k in range(2 if snoozing else 0):
            p = ((f / s + k * IDLE_FRAMES / 2) % IDLE_FRAMES) / IDLE_FRAMES
            parts.append(label_at(
                (11 + k * 2) * s + int(2 * s * math.sin(6 * p)),
                int((7 - 7 * p) * s),
                "z",
                fonts["small"],
                COLOR_LABEL if p < 0.6 else COLOR_STALE_GLOW,
            ))
        frames.append(render.Stack(children = parts))
    return render.Animation(children = frames)

def splash(message, scale):
    """Name an API error on the display. The marquee steps a pixel a frame, so
    2x halves the delay to scroll its wider text in the same time."""
    fonts = FONTS[scale]
    return render.Root(
        delay = SPLASH_FRAME_MS // scale,
        child = render.Column(
            expanded = True,
            main_align = "center",
            cross_align = "center",
            children = [
                render.Row(cross_align = "end", children = [
                    icon_art(FLAME_ART, scale),
                    render.Box(width = 2 * scale, height = 1),
                    render.Text("FLAME BOSS", font = fonts["small"], color = COLOR_HERO),
                ]),
                render.Box(width = 1, height = scale),
                render.Marquee(
                    width = canvas.width() - 2,
                    child = render.Text(message, font = fonts["small"], color = COLOR_WARN),
                ),
            ],
        ),
    )

def get_schema():
    return schema.Schema(
        version = "1",
        fields = [
            schema.Text(
                id = "api_url",
                name = "API URL",
                desc = "The flameboss exporter's /api/cook endpoint.",
                icon = "globe",
                default = DEFAULT_API_URL,
            ),
            schema.Dropdown(
                id = "units",
                name = "Units",
                desc = "Temperature units for the display.",
                icon = "temperatureHalf",
                default = "F",
                options = [
                    schema.Option(display = "Fahrenheit", value = "F"),
                    schema.Option(display = "Celsius", value = "C"),
                ],
            ),
            schema.Text(
                id = "done_f",
                name = "Pull temperature (F)",
                desc = "Meat probe temperature, in Fahrenheit, that calls PULL IT.",
                icon = "drumstickBite",
                default = "%d" % DEFAULT_DONE_F,
            ),
            schema.Text(
                id = "wrap_f",
                name = "Wrap point (F)",
                desc = "Meat probe temperature, in Fahrenheit, marked as the wrap point.",
                icon = "scroll",
                default = "%d" % DEFAULT_WRAP_F,
            ),
            schema.Toggle(
                id = "show_idle",
                name = "Show when idle",
                desc = "Show a quiet screen when no cook is running instead of skipping the app.",
                icon = "fire",
                default = False,
            ),
            schema.Text(
                id = "device",
                name = "Device",
                desc = "Flame Boss device id to follow. Blank follows a controller that is cooking, an active cook first.",
                icon = "microchip",
                default = "",
            ),
        ],
    )
