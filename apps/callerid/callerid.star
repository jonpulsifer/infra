""" Caller ID screen for the office Tidbyt

Tronbyt renders this on request when something calls its push_app API with
app_id "callerid" and a name/number/verdict config - see
docs/apps/tidbyt.md. Nothing pushes to it yet: wiring a caller into this app
is separate work.

With no number configured, main() cycles a demo through all four verdicts, so
the app browser and a pixlet render with no args both show every state.
"""

load("render.star", "canvas", "render")
load("schema.star", "schema")

FONTS = {
    1: {"big": "6x13", "small": "tom-thumb"},
    2: {"big": "10x20", "small": "tb-8"},
}

VERDICTS = ["ring", "contact", "spam", "troll"]
LABELS = {"ring": "RING", "contact": "CONTACT"}
LABEL_MAX_CHARS = {1: 7, 2: 9}

COLOR_RING = "#6fb2ff"
COLOR_CONTACT = "#3ddc84"
COLOR_SPAM = "#ff4545"
COLOR_SPAM_DIM = "#3a0d0d"
COLOR_TROLL = "#ffb300"
COLOR_WAVE = "#ffffff"
COLOR_DIM = "#8a94a6"

FRAME_MS = 120  # divided by scale on 2x
RING_STATES = 8  # icon animation states per loop
RING_HOLD = 3  # frames per ring state, multiplied by scale
SPAM_BLINKS = 4  # on/off cycles per loop
SPAM_BLINK_FRAMES = 4  # frames per blink phase, multiplied by scale

# A handset: two round cups (earpiece top-left, mouthpiece bottom-right)
# joined by a diagonal neck of small dashes, in the same pixel-art style as
# apps/tempest's icons.
PHONE_SIZE_UNITS = 20  # icon is a PHONE_SIZE_UNITS square, times scale
CUP_DIAMETER = 7
NECK_DASHES = [(5, 5), (8, 8), (11, 11)]

# Ring waves sit right of the earpiece; how many are lit cycles with the
# animation state to pulse like a ring tone.
WAVE_CELLS = [(9, 1), (12, 1), (15, 1)]

def main(config):
    """Render the caller-ID screen.

    Returns:
        A render.Root object that will be rendered by the device.
    """
    scale = 2 if canvas.is2x() else 1
    number = config.str("number", "")

    if number == "":
        return render.Root(
            delay = FRAME_MS // scale,
            show_full_animation = True,
            child = render.Sequence(children = demo_pages(scale)),
        )

    name = config.str("name", "")
    verdict = config.str("verdict", "ring")
    if verdict not in VERDICTS:
        verdict = "ring"

    return render.Root(
        delay = FRAME_MS // scale,
        show_full_animation = True,
        child = call_page(name, number, verdict, scale),
    )

def demo_pages(scale):
    demo = [
        ("", "9025551234", "ring"),
        ("Nan", "9025559876", "contact"),
        ("", "8005551234", "spam"),
        ("", "9025550000", "troll"),
    ]
    return [call_page(name, number, verdict, scale) for (name, number, verdict) in demo]

def call_page(name, number, verdict, scale):
    if verdict == "spam":
        return spam_page(number, scale)
    if verdict == "troll":
        return troll_page(name, number, scale)
    return ring_page(name, number, verdict, scale)

def ring_page(name, number, verdict, scale):
    fonts = FONTS[scale]
    color = COLOR_CONTACT if verdict == "contact" else COLOR_RING
    headline = name[0:LABEL_MAX_CHARS[scale]] if name != "" else LABELS[verdict]

    frames = []
    for state in range(RING_STATES):
        frame = render.Column(
            expanded = True,
            main_align = "space_between",
            children = [
                render.Row(
                    cross_align = "center",
                    children = [
                        phone_box(state, color, scale),
                        render.Box(width = 2 * scale, height = 1),
                        render.Text(headline, font = fonts["big"], color = color),
                    ],
                ),
                render.Text(format_number(number), font = fonts["small"], color = COLOR_DIM),
            ],
        )
        for _ in range(RING_HOLD * scale):
            frames.append(frame)
    return render.Animation(children = frames)

def spam_page(number, scale):
    fonts = FONTS[scale]

    def build(lit):
        color = COLOR_SPAM if lit else COLOR_SPAM_DIM
        return render.Column(
            expanded = True,
            main_align = "space_evenly",
            cross_align = "center",
            children = [
                render.Text("SPAM", font = fonts["big"], color = color),
                render.Text(format_number(number), font = fonts["small"], color = COLOR_DIM),
            ],
        )

    frames = []
    for _ in range(SPAM_BLINKS):
        for _ in range(SPAM_BLINK_FRAMES * scale):
            frames.append(build(True))
        for _ in range(SPAM_BLINK_FRAMES * scale):
            frames.append(build(False))
    return render.Animation(children = frames)

def troll_page(name, number, scale):
    fonts = FONTS[scale]
    ticker = "LENNY'S GOT THIS  %s" % format_number(number)

    frames = []
    for state in range(RING_STATES):
        frame = render.Column(
            expanded = True,
            main_align = "space_between",
            children = [
                render.Row(
                    expanded = True,
                    main_align = "center",
                    children = [phone_box(state, COLOR_TROLL, scale)],
                ),
                render.Marquee(
                    width = canvas.width(),
                    child = render.Text(ticker, font = fonts["small"], color = COLOR_TROLL),
                ),
            ],
        )
        for _ in range(RING_HOLD * scale):
            frames.append(frame)
    return render.Animation(children = frames)

def phone_box(state, color, scale):
    size = PHONE_SIZE_UNITS * scale
    return render.Box(
        width = size,
        height = size,
        child = render.Stack(children = phone_parts(state, color, scale)),
    )

def phone_parts(state, color, scale):
    d = CUP_DIAMETER * scale
    dash = 2 * scale
    size = PHONE_SIZE_UNITS * scale
    parts = [
        at(0, 0, render.Circle(color = color, diameter = d)),
        at(size - d, size - d, render.Circle(color = color, diameter = d)),
    ]
    for (x, y) in NECK_DASHES:
        parts.append(at(x * scale, y * scale, render.Box(width = dash, height = dash, color = color)))

    lit = state % (len(WAVE_CELLS) + 1)
    for i, (x, y) in enumerate(WAVE_CELLS):
        if i < lit:
            parts.append(at(x * scale, y * scale, render.Box(width = dash, height = dash, color = COLOR_WAVE)))
    return parts

def at(x, y, widget):
    return render.Padding(pad = (x, y, 0, 0), child = widget)

def format_number(digits):
    """Format a digits-only caller ID for display, best-effort for odd lengths."""
    if digits == "":
        return "UNKNOWN"
    d = digits
    if len(d) == 11 and d[0] == "1":
        d = d[1:]
    if len(d) == 10:
        return "(%s) %s-%s" % (d[0:3], d[3:6], d[6:10])
    return digits

def get_schema():
    return schema.Schema(
        version = "1",
        fields = [
            schema.Text(
                id = "number",
                name = "Number",
                desc = "Caller ID number, digits only. Empty shows a demo of every verdict.",
                icon = "phone",
                default = "",
            ),
            schema.Text(
                id = "name",
                name = "Name",
                desc = "Caller name, when known. Shown instead of the number for ring and contact.",
                icon = "user",
                default = "",
            ),
            schema.Dropdown(
                id = "verdict",
                name = "Verdict",
                desc = "How the call was screened.",
                icon = "phoneVolume",
                default = VERDICTS[0],
                options = [
                    schema.Option(display = "Ringing", value = "ring"),
                    schema.Option(display = "Known contact", value = "contact"),
                    schema.Option(display = "Spam", value = "spam"),
                    schema.Option(display = "Troll", value = "troll"),
                ],
            ),
        ],
    )
