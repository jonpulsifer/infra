""" Rack-top homelab status display, fed by the rackstat aggregator.

State-driven pages: when alerts fire (or nodes/probes are down) the alert
page preempts the rotation and problem rows blink. Otherwise a calm summary,
node grid, GitOps state, network probes, and a 24h CPU sparkline rotate.

Every page carries a clock in the header: the renderer runs in-cluster, so a
frozen clock means the cluster (or tronbyt) is down - a dead man's switch.

Supports 2x (128x64) displays via canvas.is2x() and the manifest supports2x.
"""

load("cache.star", "cache")
load("encoding/json.star", "json")
load("http.star", "http")
load("render.star", "canvas", "render")
load("schema.star", "schema")
load("time.star", "time")

DEFAULT_API_URL = "http://rackstat:8080/api/rackstat"
DEFAULT_TZ = "America/Halifax"
CACHE_TTL_SECONDS = 15
STALE_AFTER_SECONDS = 300

FRAME_MS = 100  # divided by scale on 2x
PAGE_FRAMES = 30  # ~3s per held page at 1x
BLINK_FRAMES = 5  # toggle blinking elements every ~0.5s

FONTS = {
    1: {"big": "6x13", "small": "tom-thumb"},
    2: {"big": "10x20", "small": "tb-8"},
}

COLOR_OK = "#3ddc84"
COLOR_BAD = "#ff4545"
COLOR_WARN = "#ffb300"
COLOR_INFO = "#6fb2ff"
COLOR_DIM = "#8a94a6"
COLOR_LABEL = "#9ab8d8"
COLOR_CLOCK = "#ffb300"
COLOR_HEADER_BG = "#101820"

def main(config):
    """Render the rackstat display.

    Returns:
        A render.Root object that will be rendered by the device.
    """
    api_url = config.str("api_url", DEFAULT_API_URL)
    tz = config.str("$tz", config.str("timezone", DEFAULT_TZ))
    scale = 2 if canvas.is2x() else 1

    snap, err = get_snapshot(api_url)
    if err != None:
        return render.Root(child = splash(err, scale))

    stale = is_stale(snap)
    trouble = has_trouble(snap)
    clock = time.now().in_location(tz).format("15:04")

    pages = []
    if trouble:
        # problems first: what is wrong, then where
        pages.append(page_alerts(snap, scale, clock, stale))
        pages.append(page_nodes(snap, scale, clock, stale))
        pages.append(page_net(snap, scale, clock, stale))
        if config.bool("show_gitops", True):
            pages.append(page_gitops(snap, scale, clock, stale))
    else:
        pages.append(page_summary(snap, scale, clock, stale))
        pages.append(page_nodes(snap, scale, clock, stale))
        if config.bool("show_gitops", True):
            pages.append(page_gitops(snap, scale, clock, stale))
        if config.bool("show_net", True):
            pages.append(page_net(snap, scale, clock, stale))
        if config.bool("show_cpu", True) and len(snap.get("cpu_history", [])) > 1:
            pages.append(page_cpu(snap, scale, clock, stale))

    return render.Root(
        delay = FRAME_MS // scale,
        show_full_animation = True,
        child = render.Sequence(children = pages),
    )

def get_snapshot(api_url):
    cache_key = "rackstat:%s" % api_url
    cached = cache.get(cache_key)
    if cached != None:
        return json.decode(cached), None

    rep = http.get(api_url)
    if rep.status_code != 200:
        return None, "rackstat API error %d" % rep.status_code
    snap = rep.json()
    if snap.get("nodes") == None:
        return None, "rackstat returned no nodes"
    cache.set(cache_key, json.encode(snap), ttl_seconds = CACHE_TTL_SECONDS)
    return snap, None

def is_stale(snap):
    if len(snap.get("errors", {})) > 0:
        return True
    generated = snap.get("generated_at", "")
    if generated == "":
        return True
    ts = time.parse_time(generated)
    return (time.now() - ts).seconds > STALE_AFTER_SECONDS

def has_trouble(snap):
    counts = snap.get("alert_counts", {})
    if counts.get("critical", 0) > 0 or counts.get("warning", 0) > 0:
        return True
    for node in snap.get("nodes", []):
        if not node.get("up", False):
            return True
        if node.get("k8s") and node.get("ready") == False:
            return True
    for probe in snap.get("probes", []):
        if not probe.get("ok", False):
            return True
    return False

# ---------------------------------------------------------------------------
# page chrome
# ---------------------------------------------------------------------------

def held(builder, scale):
    """Animate a page builder(state) for PAGE_FRAMES, blinking via state."""
    frames = []
    for i in range(PAGE_FRAMES * scale):
        frames.append(builder(i // (BLINK_FRAMES * scale) % 2 == 0))
    return render.Animation(children = frames)

def header(label, color, scale, clock, stale):
    fonts = FONTS[scale]
    if stale:
        label, color = "STALE", COLOR_WARN
    return render.Box(
        width = canvas.width(),
        height = 7 * scale,
        color = COLOR_HEADER_BG,
        child = render.Row(
            expanded = True,
            main_align = "space_between",
            cross_align = "center",
            children = [
                render.Row(children = [
                    render.Box(width = scale, height = 5 * scale, color = color),
                    render.Box(width = 2 * scale, height = 1),
                    render.Text(label, font = fonts["small"], color = color),
                ]),
                render.Text(clock, font = fonts["small"], color = COLOR_CLOCK),
            ],
        ),
    )

def framed(label, color, scale, clock, stale, body):
    return render.Column(children = [header(label, color, scale, clock, stale), body])

def dot(color, scale):
    return render.Circle(color = color, diameter = 3 * scale)

def splash(message, scale):
    fonts = FONTS[scale]
    return render.Column(
        expanded = True,
        main_align = "center",
        cross_align = "center",
        children = [
            render.Text("RACKSTAT", font = fonts["small"], color = COLOR_LABEL),
            render.Marquee(
                width = canvas.width() - 2,
                child = render.Text(message, font = fonts["small"], color = COLOR_WARN),
            ),
        ],
    )

# ---------------------------------------------------------------------------
# pages
# ---------------------------------------------------------------------------

def page_summary(snap, scale, clock, stale):
    fonts = FONTS[scale]
    nodes = snap.get("nodes", [])
    up = len([n for n in nodes if n.get("up")])
    gitops = snap.get("gitops") or {}
    probes = {p["name"]: p for p in snap.get("probes", [])}
    wan = probes.get("wan", {})

    chips = [
        chip("NODE", "%d/%d" % (up, len(nodes)), COLOR_OK if up == len(nodes) else COLOR_WARN, scale),
        chip("SYNC", "%d/%d" % (gitops.get("ks_ready", 0), gitops.get("ks_total", 0)), COLOR_OK if gitops.get("ks_ready") == gitops.get("ks_total") else COLOR_WARN, scale),
        chip("WAN", "%dms" % wan.get("ms", 0) if wan.get("ok") else "DOWN", COLOR_OK if wan.get("ok") else COLOR_BAD, scale),
    ]

    body = render.Column(
        expanded = True,
        main_align = "space_evenly",
        cross_align = "center",
        children = [
            render.Text("ALL CLEAR", font = fonts["big"], color = COLOR_OK),
            render.Row(expanded = True, main_align = "space_evenly", children = chips),
        ],
    )
    page = framed(snap.get("cluster", "rack").upper(), COLOR_OK, scale, clock, stale, body)
    return held(lambda _: page, scale)

def chip(label, value, color, scale):
    fonts = FONTS[scale]
    return render.Column(
        cross_align = "center",
        children = [
            render.Text(label, font = fonts["small"], color = COLOR_DIM),
            render.Text(value, font = fonts["small"], color = color),
        ],
    )

def page_alerts(snap, scale, clock, stale):
    fonts = FONTS[scale]
    counts = snap.get("alert_counts", {})
    alerts = snap.get("alerts", [])
    down = [n["name"] for n in snap.get("nodes", []) if not n.get("up")]
    bad_probes = [p["name"] for p in snap.get("probes", []) if not p.get("ok")]

    total = counts.get("critical", 0) + counts.get("warning", 0)
    color = COLOR_BAD if counts.get("critical", 0) > 0 or len(down) > 0 else COLOR_WARN

    problems = []
    for a in alerts:
        if a.get("severity") in ["critical", "warning"]:
            problems.append(a["name"])
    for name in down:
        problems.append("%s down" % name)
    for name in bad_probes:
        problems.append("%s unreachable" % name)
    if len(problems) == 0:
        problems = ["node not ready"]

    def build(on):
        headline = render.Row(
            main_align = "center",
            cross_align = "center",
            children = [
                dot(color if on else COLOR_HEADER_BG, scale),
                render.Box(width = 2 * scale, height = 1),
                render.Text("%d ISSUE%s" % (max(total, len(problems)), "S" if max(total, len(problems)) != 1 else ""), font = fonts["big"], color = color),
            ],
        )
        return framed("ALERT", color, scale, clock, stale, render.Column(
            expanded = True,
            main_align = "space_evenly",
            cross_align = "center",
            children = [
                headline,
                render.Marquee(
                    width = canvas.width(),
                    offset_start = 8 * scale,
                    child = render.Text("  ".join(problems), font = fonts["small"], color = "#ffffff"),
                ),
            ],
        ))

    return held(build, scale)

def node_color(node, on):
    if not node.get("up"):
        return COLOR_BAD if on else "#401010"
    if node.get("k8s") and node.get("ready") == False:
        return COLOR_WARN if on else "#403010"
    temp = node.get("temp_c")
    if temp != None and temp >= 75:
        return COLOR_WARN
    return COLOR_OK

def page_nodes(snap, scale, clock, stale):
    fonts = FONTS[scale]
    nodes = snap.get("nodes", [])

    def build(on):
        k8s = [n for n in nodes if n.get("k8s")]
        bare = [n for n in nodes if not n.get("k8s")]
        cols = []
        for group in [k8s, bare]:
            rows = []
            for n in group[0:4]:
                name = n["name"][0:6 if scale == 1 else 8]
                row = [
                    dot(node_color(n, on), scale),
                    render.Box(width = scale, height = 1),
                    render.Text(name, font = fonts["small"], color = "#ffffff" if n.get("up") else COLOR_DIM),
                ]
                if scale == 2 and n.get("temp_c") != None:
                    row.append(render.Box(width = 2, height = 1))
                    row.append(render.Text("%d°" % int(n["temp_c"]), font = fonts["small"], color = COLOR_DIM))
                rows.append(render.Row(cross_align = "center", children = row))
            cols.append(render.Column(main_align = "space_evenly", expanded = True, children = rows))
        return framed("NODES", COLOR_LABEL, scale, clock, stale, render.Row(
            expanded = True,
            main_align = "space_evenly",
            children = cols,
        ))

    return held(build, scale)

def page_gitops(snap, scale, clock, stale):
    fonts = FONTS[scale]
    g = snap.get("gitops") or {}
    ks_ok = g.get("ks_ready", 0) == g.get("ks_total", 0)
    hr_ok = g.get("hr_ready", 0) == g.get("hr_total", 0)
    revision = g.get("revision", "")
    sha = revision.split(":")[-1][0:7] if ":" in revision else "unknown"
    branch = revision.split("@")[0] if "@" in revision else "rev"

    def line(label, ready, total, ok):
        return render.Row(
            cross_align = "center",
            children = [
                dot(COLOR_OK if ok else COLOR_WARN, scale),
                render.Box(width = 2 * scale, height = 1),
                render.Text("%s %d/%d" % (label, ready, total), font = fonts["small"], color = "#ffffff" if ok else COLOR_WARN),
            ],
        )

    body = render.Column(
        expanded = True,
        main_align = "space_evenly",
        cross_align = "center",
        children = [
            line("KS", g.get("ks_ready", 0), g.get("ks_total", 0), ks_ok),
            line("HR", g.get("hr_ready", 0), g.get("hr_total", 0), hr_ok),
            render.Text("%s %s" % (branch, sha), font = fonts["small"], color = COLOR_INFO),
        ],
    )
    page = framed("GITOPS", COLOR_OK if ks_ok and hr_ok else COLOR_WARN, scale, clock, stale, body)
    return held(lambda _: page, scale)

def page_net(snap, scale, clock, stale):
    fonts = FONTS[scale]
    probes = snap.get("probes", [])
    all_ok = all([p.get("ok") for p in probes]) if len(probes) > 0 else False

    def build(on):
        rows = []
        for p in probes[0:3]:
            ok = p.get("ok", False)
            rows.append(render.Row(
                expanded = True,
                main_align = "space_between",
                cross_align = "center",
                children = [
                    render.Row(cross_align = "center", children = [
                        dot((COLOR_OK if ok else (COLOR_BAD if on else "#401010")), scale),
                        render.Box(width = 2 * scale, height = 1),
                        render.Text(p["name"].upper(), font = fonts["small"], color = "#ffffff" if ok else COLOR_BAD),
                    ]),
                    render.Text("%dms" % p.get("ms", 0) if ok else "DOWN", font = fonts["small"], color = COLOR_DIM if ok else COLOR_BAD),
                ],
            ))
        return framed("NET", COLOR_OK if all_ok else COLOR_BAD, scale, clock, stale, render.Box(
            padding = 2 * scale,
            child = render.Column(expanded = True, main_align = "space_evenly", children = rows),
        ))

    return held(build, scale)

def page_cpu(snap, scale, clock, stale):
    history = snap.get("cpu_history", [])
    now = history[-1] if len(history) > 0 else 0

    plot = render.Plot(
        data = [(i, history[i]) for i in range(len(history))],
        width = canvas.width(),
        height = 25 * scale,
        color = COLOR_INFO,
        fill = True,
        fill_color = "#0a2c55",
        y_lim = (0, None),
    )
    page = framed("CPU 24H  %d%%" % int(now), COLOR_INFO, scale, clock, stale, plot)
    return held(lambda _: page, scale)

# ---------------------------------------------------------------------------
# schema
# ---------------------------------------------------------------------------

def get_schema():
    return schema.Schema(
        version = "1",
        fields = [
            schema.Text(
                id = "api_url",
                name = "API URL",
                desc = "rackstat aggregator endpoint.",
                icon = "globe",
                default = DEFAULT_API_URL,
            ),
            schema.Text(
                id = "timezone",
                name = "Timezone",
                desc = "Fallback timezone for the clock when the device does not provide one.",
                icon = "clock",
                default = DEFAULT_TZ,
            ),
            schema.Toggle(
                id = "show_gitops",
                name = "GitOps page",
                desc = "Show Flux kustomization/helmrelease status.",
                icon = "codeBranch",
                default = True,
            ),
            schema.Toggle(
                id = "show_net",
                name = "Network page",
                desc = "Show WAN/offsite/LB probe status.",
                icon = "networkWired",
                default = True,
            ),
            schema.Toggle(
                id = "show_cpu",
                name = "CPU page",
                desc = "Show the 24h cluster CPU graph.",
                icon = "chartLine",
                default = True,
            ),
        ],
    )
