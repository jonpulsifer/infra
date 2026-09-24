""" Display today's Nova Scotia fire restrictions for up to two counties.

BurnSafe publishes no API, so this reads the county table on the public page:
each row is `<tr id="<County>-County">` with a `status-<level>` cell.

Supports 2x (128x64) displays: all dimensions scale off canvas.is2x()
and the manifest sets supports2x.
"""

load("html.star", "html")
load("http.star", "http")
load("render.star", "canvas", "render")
load("schema.star", "schema")

DEFAULT_URL = "https://novascotia.ca/burnsafe/"
CACHE_TTL_SECONDS = 600

COUNTIES = [
    "Annapolis",
    "Antigonish",
    "Cape Breton",
    "Colchester",
    "Cumberland",
    "Digby",
    "Guysborough",
    "Halifax",
    "Hants",
    "Inverness",
    "Kings",
    "Lunenburg",
    "Pictou",
    "Queens",
    "Richmond",
    "Shelburne",
    "Victoria",
    "Yarmouth",
]

# The page's own legend colours, and the hours each level allows burning.
LEVELS = {
    "burn": {"color": "#408334", "window": "2PM-8AM"},
    "restricted": {"color": "#ffc022", "window": "7PM-8AM"},
    "no-burn": {"color": "#cb1f18", "window": "NO BURN"},
}

# fonts per scale: site name, burn window
FONTS = {
    1: {"name": "tb-8", "small": "tom-thumb"},
    2: {"name": "terminus-16", "small": "tb-8"},
}

COLOR_NAME = "#e8e8e8"
COLOR_DIM = "#8a94a6"
COLOR_LABEL = "#ff9a4d"

def main(config):
    scale = 2 if canvas.is2x() else 1
    sites = [
        (config.str("county_1", "Colchester"), config.str("label_1", "Folly")),
        (config.str("county_2", "Halifax"), config.str("label_2", "Old School")),
    ]
    sites = [s for s in sites if s[0] != "none"]

    # `url` has no schema field: it exists to render against a saved page.
    rep = http.get(config.str("url", DEFAULT_URL), ttl_seconds = CACHE_TTL_SECONDS)
    if rep.status_code != 200:
        return splash("BurnSafe error %d" % rep.status_code, scale)
    doc = html(rep.body())

    return render.Root(
        child = render.Column(
            expanded = True,
            main_align = "space_evenly",
            children = [site_row(doc, county, label, scale) for county, label in sites],
        ),
    )

def restriction(doc, county):
    """The level class and the page's wording for one county, or (None, None)."""
    cell = doc.find("tr#%s-County td" % county.replace(" ", "-"))
    if cell.len() == 0:
        return None, None
    level = cell.attr("class").removeprefix("status-")
    return level, cell.find("p").text().strip()

def site_row(doc, county, label, scale):
    fonts = FONTS[scale]
    level, text = restriction(doc, county)
    style = LEVELS.get(level)
    dot = 9 * scale
    gap = 3 * scale
    text_width = canvas.width() - dot - gap - scale

    if style != None:
        detail = render.Text(style["window"], font = fonts["small"], color = style["color"])
    else:
        detail = render.Marquee(
            width = text_width,
            child = render.Text(text or "NO DATA", font = fonts["small"], color = COLOR_DIM),
        )

    return render.Row(
        cross_align = "center",
        children = [
            render.Box(width = scale, height = 1),
            render.Circle(diameter = dot, color = style["color"] if style else COLOR_DIM),
            render.Box(width = gap, height = 1),
            render.Column(children = [
                render.Marquee(
                    width = text_width,
                    child = render.Text(label.upper(), font = fonts["name"], color = COLOR_NAME),
                ),
                detail,
            ]),
        ],
    )

def splash(message, scale):
    fonts = FONTS[scale]
    return render.Root(
        child = render.Column(
            expanded = True,
            main_align = "center",
            cross_align = "center",
            children = [
                render.Text("BURNSAFE", font = fonts["name"], color = COLOR_LABEL),
                render.Marquee(
                    width = canvas.width() - 2,
                    child = render.Text(message, font = fonts["small"], color = COLOR_DIM),
                ),
            ],
        ),
    )

def county_options(none):
    options = [schema.Option(display = "None", value = "none")] if none else []
    return options + [schema.Option(display = "%s County" % c, value = c) for c in COUNTIES]

def get_schema():
    return schema.Schema(
        version = "1",
        fields = [
            schema.Dropdown(
                id = "county_1",
                name = "First county",
                desc = "County of the first site.",
                icon = "fire",
                default = "Colchester",
                options = county_options(False),
            ),
            schema.Text(
                id = "label_1",
                name = "First label",
                desc = "Name shown for the first site.",
                icon = "tag",
                default = "Folly",
            ),
            schema.Dropdown(
                id = "county_2",
                name = "Second county",
                desc = "County of the second site, or None for one site.",
                icon = "fire",
                default = "Halifax",
                options = county_options(True),
            ),
            schema.Text(
                id = "label_2",
                name = "Second label",
                desc = "Name shown for the second site.",
                icon = "tag",
                default = "Old School",
            ),
        ],
    )
